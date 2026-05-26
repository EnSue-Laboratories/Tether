use anyhow::{anyhow, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs as unix_fs;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROTOCOL_VERSION: u64 = 1;
const DEFAULT_EVENTS_PER_SESSION: usize = 5000;
const DEFAULT_BYTES_PER_SESSION: usize = 8 * 1024 * 1024;
const DEFAULT_BODY_MAX_BYTES: usize = 64 * 1024;
const NATIVE_HOST_NAME: &str = "com.ensue.tether";
const EXTENSION_ID: &str = "lcbgiapgidfgdaohjbofohaokokcpefd";

#[derive(Parser)]
#[command(name = "tether", about = "Browser console and network logs for agents")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the native-host daemon.
    Daemon(DaemonArgs),
    /// Show daemon, extension, capture, session, and buffer state.
    Status(OutputArgs),
    /// List active sessions.
    Sessions(OutputArgs),
    /// Read recent console entries.
    Console(ConsoleArgs),
    /// Read recent network entries.
    Net(NetArgs),
    /// Read full detail for one request.
    Get(GetArgs),
    /// Clear buffered events.
    Clear(SessionArgs),
    /// Export buffered events.
    Export(ExportArgs),
    /// View or update config.
    Config(ConfigArgs),
    /// Install the Chrome/Chromium Native Messaging host manifest.
    InstallHost(InstallHostArgs),
}

#[derive(Args)]
struct DaemonArgs {
    /// Run without Native Messaging stdin/stdout. Useful for local smoke tests.
    #[arg(long)]
    no_native: bool,
}

#[derive(Args, Clone)]
struct OutputArgs {
    #[arg(long)]
    json: bool,
}

#[derive(Args, Clone)]
struct SessionArgs {
    #[arg(long)]
    session: Option<String>,
    #[arg(long)]
    tab: Option<i64>,
}

#[derive(Args, Clone)]
struct ConsoleArgs {
    #[command(flatten)]
    session: SessionArgs,
    #[arg(long, value_delimiter = ',')]
    level: Vec<String>,
    #[arg(long)]
    grep: Option<String>,
    #[arg(long)]
    since: Option<String>,
    #[arg(short = 'n', long = "count", default_value_t = 50)]
    count: usize,
    #[arg(long)]
    json: bool,
}

#[derive(Args, Clone)]
struct NetArgs {
    #[command(flatten)]
    session: SessionArgs,
    #[arg(long)]
    method: Option<String>,
    #[arg(long)]
    status: Option<String>,
    #[arg(long)]
    url: Option<String>,
    #[arg(long = "type", value_delimiter = ',')]
    resource_type: Vec<String>,
    #[arg(long)]
    since: Option<String>,
    #[arg(short = 'n', long = "count", default_value_t = 50)]
    count: usize,
    #[arg(long)]
    json: bool,
}

#[derive(Args, Clone)]
struct GetArgs {
    request_id: String,
    #[arg(long)]
    headers: bool,
    #[arg(long)]
    body: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Args, Clone)]
struct ExportArgs {
    #[command(flatten)]
    session: SessionArgs,
    #[arg(long, value_enum, default_value_t = ExportFormat::Json)]
    format: ExportFormat,
    #[arg(short = 'o', long)]
    output: Option<PathBuf>,
}

#[derive(Copy, Clone, Eq, PartialEq, ValueEnum)]
enum ExportFormat {
    Json,
    Har,
}

#[derive(Args, Clone)]
struct ConfigArgs {
    action: Option<String>,
    key: Option<String>,
    value: Option<String>,
    #[arg(long)]
    json: bool,
}

#[derive(Args, Clone)]
struct InstallHostArgs {
    /// Path to the tether binary. Defaults to the currently-running executable.
    #[arg(long)]
    binary: Option<PathBuf>,
    /// Only print what would be written.
    #[arg(long)]
    dry_run: bool,
    /// Browser target: chrome, chromium, or all.
    #[arg(long, value_enum, default_value_t = BrowserTarget::All)]
    browser: BrowserTarget,
}

#[derive(Copy, Clone, Eq, PartialEq, ValueEnum)]
enum BrowserTarget {
    All,
    Chrome,
    Chromium,
}

#[derive(Debug, Deserialize)]
struct NativeEventsMessage {
    v: u64,
    kind: String,
    events: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct SocketRequest {
    v: u64,
    cmd: String,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    tab: Option<i64>,
    #[serde(default)]
    args: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    tab_id: i64,
    url: Option<String>,
    title: Option<String>,
    opened: bool,
    event_count: usize,
    byte_count: usize,
    console_count: usize,
    network_count: usize,
    last_activity: i64,
    next_seq: u64,
}

#[derive(Clone)]
struct SessionBuffer {
    info: SessionInfo,
    events: VecDeque<Value>,
}

#[derive(Clone, Serialize)]
struct CaptureConfig {
    console: bool,
    network: bool,
    bodies: bool,
}

#[derive(Clone, Serialize)]
struct LimitConfig {
    per_session_events: usize,
    per_session_bytes: usize,
    body_max_bytes: usize,
}

#[derive(Clone, Serialize)]
struct RedactConfig {
    headers: Vec<String>,
}

#[derive(Clone, Serialize)]
struct DaemonConfig {
    capture: CaptureConfig,
    limits: LimitConfig,
    redact: RedactConfig,
}

struct DaemonState {
    sessions: HashMap<String, SessionBuffer>,
    active_session: Option<String>,
    extension_connected: bool,
    config: DaemonConfig,
}

impl Default for DaemonState {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            active_session: None,
            extension_connected: false,
            config: DaemonConfig {
                capture: CaptureConfig {
                    console: true,
                    network: true,
                    bodies: false,
                },
                limits: LimitConfig {
                    per_session_events: DEFAULT_EVENTS_PER_SESSION,
                    per_session_bytes: DEFAULT_BYTES_PER_SESSION,
                    body_max_bytes: DEFAULT_BODY_MAX_BYTES,
                },
                redact: RedactConfig {
                    headers: vec![
                        "authorization".into(),
                        "cookie".into(),
                        "set-cookie".into(),
                        "proxy-authorization".into(),
                    ],
                },
            },
        }
    }
}

impl DaemonState {
    fn ingest_events(&mut self, events: Vec<Value>) -> Result<()> {
        for mut event in events {
            if let Err(err) = self.ingest_event(&mut event) {
                eprintln!("tetherd ignored invalid event: {err:#}");
            }
        }
        Ok(())
    }

    fn ingest_event(&mut self, event: &mut Value) -> Result<()> {
        let obj = event
            .as_object_mut()
            .ok_or_else(|| anyhow!("event must be an object"))?;
        let event_type = get_str(obj, "type")?.to_string();
        let session_id = get_str(obj, "sessionId")?.to_string();
        let tab_id = get_i64(obj, "tabId")?;
        let ts = get_i64(obj, "ts").unwrap_or_else(|_| now_ms());
        if obj.contains_key("seq") {
            obj.remove("seq");
        }

        let buffer = self
            .sessions
            .entry(session_id.clone())
            .or_insert_with(|| SessionBuffer {
                info: SessionInfo {
                    id: session_id.clone(),
                    tab_id,
                    url: None,
                    title: None,
                    opened: true,
                    event_count: 0,
                    byte_count: 0,
                    console_count: 0,
                    network_count: 0,
                    last_activity: ts,
                    next_seq: 1,
                },
                events: VecDeque::new(),
            });

        let seq = buffer.info.next_seq;
        buffer.info.next_seq += 1;
        obj.insert("seq".into(), Value::from(seq));
        buffer.info.tab_id = tab_id;
        buffer.info.last_activity = ts;
        match event_type.as_str() {
            "console" => buffer.info.console_count += 1,
            "network" => buffer.info.network_count += 1,
            "session" => {
                if let Some(url) = obj.get("url").and_then(Value::as_str) {
                    buffer.info.url = Some(url.to_string());
                }
                if let Some(title) = obj.get("title").and_then(Value::as_str) {
                    buffer.info.title = Some(title.to_string());
                }
                buffer.info.opened = obj.get("event").and_then(Value::as_str) != Some("closed");
            }
            _ => return Err(anyhow!("unknown event type: {event_type}")),
        }

        let event_bytes = json_len(event);
        buffer.info.byte_count += event_bytes;
        buffer.events.push_back(event.clone());
        buffer.info.event_count = buffer.events.len();
        self.active_session = Some(session_id);
        self.enforce_limits_for_active();
        Ok(())
    }

    fn enforce_limits_for_active(&mut self) {
        let Some(id) = self.active_session.clone() else {
            return;
        };
        let Some(buffer) = self.sessions.get_mut(&id) else {
            return;
        };
        let max_events = self.config.limits.per_session_events;
        let max_bytes = self.config.limits.per_session_bytes;
        while buffer.events.len() > max_events || buffer.info.byte_count > max_bytes {
            if let Some(old) = buffer.events.pop_front() {
                buffer.info.byte_count = buffer.info.byte_count.saturating_sub(json_len(&old));
            } else {
                break;
            }
        }
        buffer.info.event_count = buffer.events.len();
    }

    fn resolve_session(&self, session: Option<&str>, tab: Option<i64>) -> Option<&SessionBuffer> {
        if let Some(id) = session {
            return self.sessions.get(id);
        }
        if let Some(tab_id) = tab {
            return self
                .sessions
                .values()
                .filter(|s| s.info.tab_id == tab_id)
                .max_by_key(|s| s.info.last_activity);
        }
        self.active_session
            .as_deref()
            .and_then(|id| self.sessions.get(id))
            .or_else(|| self.sessions.values().max_by_key(|s| s.info.last_activity))
    }

    fn clear(&mut self, session: Option<&str>) {
        if let Some(id) = session {
            if let Some(buffer) = self.sessions.get_mut(id) {
                buffer.events.clear();
                buffer.info.event_count = 0;
                buffer.info.byte_count = 0;
                buffer.info.console_count = 0;
                buffer.info.network_count = 0;
            }
        } else {
            self.sessions.clear();
            self.active_session = None;
        }
    }
}

#[derive(Debug)]
enum DaemonReply {
    Unary(Value),
    Stream(Vec<Value>),
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<ExitCode> {
    let argv0 = env::args().next().unwrap_or_default();
    if argv0.ends_with("tetherd") {
        return run_daemon(DaemonArgs { no_native: false }).map(|_| ExitCode::SUCCESS);
    }

    let cli = Cli::parse();
    match cli
        .command
        .unwrap_or(Command::Status(OutputArgs { json: false }))
    {
        Command::Daemon(args) => run_daemon(args).map(|_| ExitCode::SUCCESS),
        command => run_cli(command),
    }
}

fn run_daemon(args: DaemonArgs) -> Result<()> {
    let state = Arc::new(Mutex::new(DaemonState::default()));
    let socket_path = socket_path()?;
    start_socket_server(socket_path, Arc::clone(&state))?;

    if args.no_native {
        loop {
            thread::park_timeout(Duration::from_secs(3600));
        }
    }

    {
        let mut locked = state.lock().unwrap();
        locked.extension_connected = true;
    }
    write_native_control(&mut io::stdout().lock(), &state.lock().unwrap().config)?;
    let result = read_native_loop(Arc::clone(&state));
    state.lock().unwrap().extension_connected = false;
    result
}

fn start_socket_server(path: PathBuf, state: Arc<Mutex<DaemonState>>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("remove stale socket {}", path.display()))?;
    }
    let listener = UnixListener::bind(&path).with_context(|| format!("bind {}", path.display()))?;
    thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => {
                    let state = Arc::clone(&state);
                    thread::spawn(move || {
                        if let Err(err) = handle_socket_stream(stream, state) {
                            eprintln!("tetherd socket error: {err:#}");
                        }
                    });
                }
                Err(err) => eprintln!("tetherd accept error: {err}"),
            }
        }
    });
    Ok(())
}

fn read_native_loop(state: Arc<Mutex<DaemonState>>) -> Result<()> {
    let mut stdin = io::stdin().lock();
    loop {
        let mut len_buf = [0u8; 4];
        match stdin.read_exact(&mut len_buf) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(err) => return Err(err).context("read native message length"),
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        if len == 0 || len > 16 * 1024 * 1024 {
            return Err(anyhow!("invalid native message length: {len}"));
        }
        let mut data = vec![0u8; len];
        stdin
            .read_exact(&mut data)
            .context("read native message payload")?;
        let message: NativeEventsMessage =
            serde_json::from_slice(&data).context("parse native message")?;
        if message.v != PROTOCOL_VERSION {
            continue;
        }
        if message.kind == "events" {
            state.lock().unwrap().ingest_events(message.events)?;
        }
    }
}

fn write_native_control<W: Write>(out: &mut W, config: &DaemonConfig) -> Result<()> {
    let message = json!({
        "v": PROTOCOL_VERSION,
        "kind": "control",
        "capture": {
            "console": config.capture.console,
            "network": config.capture.network,
            "bodies": config.capture.bodies,
        },
        "limits": {
            "perSessionEvents": config.limits.per_session_events,
            "bodyMaxBytes": config.limits.body_max_bytes,
        },
        "redact": { "headers": config.redact.headers },
        "filter": { "urlAllow": [], "urlDeny": [] },
    });
    let bytes = serde_json::to_vec(&message)?;
    out.write_all(&(bytes.len() as u32).to_le_bytes())?;
    out.write_all(&bytes)?;
    out.flush()?;
    Ok(())
}

fn handle_socket_stream(mut stream: UnixStream, state: Arc<Mutex<DaemonState>>) -> Result<()> {
    let mut data = String::new();
    stream.read_to_string(&mut data)?;
    let request: SocketRequest =
        serde_json::from_str(data.trim()).context("parse socket request")?;
    if request.v != PROTOCOL_VERSION {
        write_unary_error(&mut stream, "BAD_VERSION", "unsupported protocol version")?;
        return Ok(());
    }
    match handle_socket_request(&request, &mut state.lock().unwrap()) {
        Ok(DaemonReply::Unary(data)) => write_unary_ok(&mut stream, data)?,
        Ok(DaemonReply::Stream(events)) => write_stream_ok(&mut stream, events)?,
        Err(err) => write_unary_error(&mut stream, err.code, err.message)?,
    }
    Ok(())
}

#[derive(Debug)]
struct DaemonError {
    code: &'static str,
    message: &'static str,
}

fn handle_socket_request(
    req: &SocketRequest,
    state: &mut DaemonState,
) -> Result<DaemonReply, DaemonError> {
    match req.cmd.as_str() {
        "status" => Ok(DaemonReply::Unary(json!({
            "daemon": true,
            "extensionConnected": state.extension_connected,
            "capture": state.config.capture,
            "sessions": state.sessions.len(),
            "activeSession": state.active_session,
            "buffer": {
                "events": state.sessions.values().map(|s| s.info.event_count).sum::<usize>(),
                "bytes": state.sessions.values().map(|s| s.info.byte_count).sum::<usize>(),
            }
        }))),
        "sessions" => {
            ensure_extension_or_data(state)?;
            let mut sessions: Vec<_> = state.sessions.values().map(|s| &s.info).collect();
            sessions.sort_by_key(|s| s.last_activity);
            sessions.reverse();
            Ok(DaemonReply::Unary(json!({ "sessions": sessions })))
        }
        "console" => {
            ensure_extension_or_data(state)?;
            let session = state
                .resolve_session(req.session.as_deref(), req.tab)
                .ok_or(NO_SESSION)?;
            Ok(DaemonReply::Stream(filter_console(session, &req.args)?))
        }
        "net" => {
            ensure_extension_or_data(state)?;
            let session = state
                .resolve_session(req.session.as_deref(), req.tab)
                .ok_or(NO_SESSION)?;
            Ok(DaemonReply::Stream(filter_network(session, &req.args)?))
        }
        "get" => {
            ensure_extension_or_data(state)?;
            let request_id =
                req.args
                    .get("requestId")
                    .and_then(Value::as_str)
                    .ok_or(DaemonError {
                        code: "BAD_REQUEST",
                        message: "requestId required",
                    })?;
            let mut phases: Vec<Value> = state
                .sessions
                .values()
                .flat_map(|s| s.events.iter())
                .filter(|e| e.get("requestId").and_then(Value::as_str) == Some(request_id))
                .cloned()
                .collect();
            phases.sort_by_key(|e| e.get("seq").and_then(Value::as_u64).unwrap_or(0));
            if phases.is_empty() {
                return Err(NO_SESSION);
            }
            let latest = phases.last().cloned().unwrap_or(Value::Null);
            Ok(DaemonReply::Unary(json!({
                "requestId": request_id,
                "latest": latest,
                "phases": phases,
            })))
        }
        "clear" => {
            let clear_id = req.session.clone().or_else(|| {
                req.tab.and_then(|tab| {
                    state
                        .resolve_session(None, Some(tab))
                        .map(|s| s.info.id.clone())
                })
            });
            state.clear(clear_id.as_deref());
            Ok(DaemonReply::Unary(json!({ "cleared": true })))
        }
        "config" => {
            if req.args.get("action").and_then(Value::as_str) == Some("set") {
                return Err(DaemonError {
                    code: "NOT_IMPLEMENTED",
                    message: "config set is planned after the core query path",
                });
            }
            Ok(DaemonReply::Unary(json!({ "config": state.config })))
        }
        "export" => {
            ensure_extension_or_data(state)?;
            let session = state
                .resolve_session(req.session.as_deref(), req.tab)
                .ok_or(NO_SESSION)?;
            Ok(DaemonReply::Stream(
                session.events.iter().cloned().collect(),
            ))
        }
        "watch" => Err(DaemonError {
            code: "NOT_IMPLEMENTED",
            message: "watch is planned after the core query path",
        }),
        _ => Err(DaemonError {
            code: "BAD_REQUEST",
            message: "unknown command",
        }),
    }
}

const NO_SESSION: DaemonError = DaemonError {
    code: "NO_SESSION",
    message: "no matching session",
};

const NO_EXTENSION: DaemonError = DaemonError {
    code: "NO_EXTENSION",
    message: "no extension connected",
};

fn ensure_extension_or_data(state: &DaemonState) -> Result<(), DaemonError> {
    if !state.extension_connected && state.sessions.is_empty() {
        Err(NO_EXTENSION)
    } else {
        Ok(())
    }
}

fn write_unary_ok(stream: &mut UnixStream, data: Value) -> Result<()> {
    writeln!(stream, "{}", json!({ "ok": true, "data": data }))?;
    Ok(())
}

fn write_unary_error(stream: &mut UnixStream, code: &str, message: &str) -> Result<()> {
    writeln!(
        stream,
        "{}",
        json!({ "ok": false, "code": code, "message": message })
    )?;
    Ok(())
}

fn write_stream_ok(stream: &mut UnixStream, events: Vec<Value>) -> Result<()> {
    writeln!(stream, "{}", json!({ "ok": true, "stream": true }))?;
    for event in events {
        writeln!(stream, "{}", event)?;
    }
    Ok(())
}

fn run_cli(command: Command) -> Result<ExitCode> {
    match command {
        Command::Status(args) => {
            query_unary("status", None, None, json!({}), args.json, print_status)
        }
        Command::Sessions(args) => {
            query_unary("sessions", None, None, json!({}), args.json, print_sessions)
        }
        Command::Console(args) => query_stream(
            "console",
            args.session.session.as_deref(),
            args.session.tab,
            json!({
                "level": args.level,
                "grep": args.grep,
                "since": args.since,
                "limit": args.count,
            }),
            args.json,
            print_console_event,
        ),
        Command::Net(args) => query_stream(
            "net",
            args.session.session.as_deref(),
            args.session.tab,
            json!({
                "method": args.method,
                "status": args.status,
                "url": args.url,
                "type": args.resource_type,
                "since": args.since,
                "limit": args.count,
            }),
            args.json,
            print_network_event,
        ),
        Command::Get(args) => query_unary(
            "get",
            None,
            None,
            json!({ "requestId": args.request_id, "headers": args.headers, "body": args.body }),
            args.json,
            print_get,
        ),
        Command::Clear(args) => query_unary(
            "clear",
            args.session.as_deref(),
            args.tab,
            json!({}),
            false,
            |_| println!("cleared"),
        ),
        Command::Export(args) => export_command(args),
        Command::Config(args) => query_unary(
            "config",
            None,
            None,
            json!({ "action": args.action, "key": args.key, "value": args.value }),
            args.json,
            |data| println!("{}", serde_json::to_string_pretty(data).unwrap()),
        ),
        Command::InstallHost(args) => install_host(args),
        Command::Daemon(_) => unreachable!(),
    }
}

fn query_unary<F>(
    cmd: &str,
    session: Option<&str>,
    tab: Option<i64>,
    args: Value,
    json_output: bool,
    print: F,
) -> Result<ExitCode>
where
    F: FnOnce(&Value),
{
    let response = send_socket_request(cmd, session, tab, args)?;
    let mut lines = response.lines();
    let Some(first) = lines.next() else {
        return Ok(ExitCode::from(1));
    };
    let value: Value = serde_json::from_str(first)?;
    if !value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(error_exit(&value));
    }
    let data = value.get("data").unwrap_or(&Value::Null);
    if json_output {
        println!("{}", serde_json::to_string_pretty(data)?);
    } else {
        print(data);
    }
    Ok(ExitCode::SUCCESS)
}

fn query_stream<F>(
    cmd: &str,
    session: Option<&str>,
    tab: Option<i64>,
    args: Value,
    json_output: bool,
    print: F,
) -> Result<ExitCode>
where
    F: Fn(&Value),
{
    let response = send_socket_request(cmd, session, tab, args)?;
    let mut lines = response.lines();
    let Some(first) = lines.next() else {
        return Ok(ExitCode::from(1));
    };
    let header: Value = serde_json::from_str(first)?;
    if !header.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(error_exit(&header));
    }
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let event: Value = serde_json::from_str(line)?;
        if json_output {
            println!("{event}");
        } else {
            print(&event);
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn send_socket_request(
    cmd: &str,
    session: Option<&str>,
    tab: Option<i64>,
    args: Value,
) -> Result<String> {
    let path = socket_path()?;
    let mut stream = match UnixStream::connect(&path) {
        Ok(stream) => stream,
        Err(err) => {
            eprintln!(
                "daemon not running at {} ({err}); start `tether daemon --no-native` for local testing or open the extension",
                path.display()
            );
            std::process::exit(3);
        }
    };
    let request = json!({
        "v": PROTOCOL_VERSION,
        "cmd": cmd,
        "session": session,
        "tab": tab,
        "args": args,
    });
    stream.write_all(serde_json::to_string(&request)?.as_bytes())?;
    stream.shutdown(std::net::Shutdown::Write)?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn export_command(args: ExportArgs) -> Result<ExitCode> {
    if args.format == ExportFormat::Har {
        eprintln!("HAR export is planned after the core JSON query path");
        return Ok(ExitCode::from(1));
    }
    let response = send_socket_request(
        "export",
        args.session.session.as_deref(),
        args.session.tab,
        json!({}),
    )?;
    let mut output: Box<dyn Write> = if let Some(path) = args.output {
        Box::new(fs::File::create(path)?)
    } else {
        Box::new(io::stdout())
    };
    for (idx, line) in response.lines().enumerate() {
        if idx == 0 {
            let header: Value = serde_json::from_str(line)?;
            if !header.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(error_exit(&header));
            }
            continue;
        }
        writeln!(output, "{line}")?;
    }
    Ok(ExitCode::SUCCESS)
}

fn error_exit(value: &Value) -> ExitCode {
    let code = value.get("code").and_then(Value::as_str).unwrap_or("ERROR");
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("request failed");
    eprintln!("{code}: {message}");
    match code {
        "NO_EXTENSION" => ExitCode::from(4),
        "NO_SESSION" => ExitCode::from(5),
        _ => ExitCode::from(1),
    }
}

fn print_status(data: &Value) {
    println!(
        "daemon: up\nextension: {}\nsessions: {}\nactive: {}",
        yes_no(
            data.get("extensionConnected")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
        data.get("sessions").and_then(Value::as_u64).unwrap_or(0),
        data.get("activeSession")
            .and_then(Value::as_str)
            .unwrap_or("-")
    );
}

fn print_sessions(data: &Value) {
    println!(
        "{:<18} {:<6} {:<7} {:<8} URL",
        "SESSION", "TAB", "EVENTS", "STATE"
    );
    if let Some(sessions) = data.get("sessions").and_then(Value::as_array) {
        for s in sessions {
            let state = if s.get("opened").and_then(Value::as_bool).unwrap_or(false) {
                "open"
            } else {
                "closed"
            };
            println!(
                "{:<18} {:<6} {:<7} {:<8} {}",
                s.get("id").and_then(Value::as_str).unwrap_or("-"),
                s.get("tabId").and_then(Value::as_i64).unwrap_or_default(),
                s.get("eventCount")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                state,
                s.get("url").and_then(Value::as_str).unwrap_or("-")
            );
        }
    }
}

fn print_console_event(event: &Value) {
    println!(
        "#{:<5} {:<5} {}",
        event.get("seq").and_then(Value::as_u64).unwrap_or_default(),
        event.get("level").and_then(Value::as_str).unwrap_or("-"),
        event.get("text").and_then(Value::as_str).unwrap_or("")
    );
}

fn print_network_event(event: &Value) {
    println!(
        "#{:<5} {:<8} {:<6} {:<4} {}",
        event.get("seq").and_then(Value::as_u64).unwrap_or_default(),
        event.get("phase").and_then(Value::as_str).unwrap_or("-"),
        event.get("method").and_then(Value::as_str).unwrap_or("-"),
        event
            .get("status")
            .and_then(Value::as_i64)
            .map(|s| s.to_string())
            .unwrap_or_else(|| "-".into()),
        event.get("url").and_then(Value::as_str).unwrap_or("")
    );
}

fn print_get(data: &Value) {
    println!("{}", serde_json::to_string_pretty(data).unwrap());
}

fn filter_console(session: &SessionBuffer, args: &Value) -> Result<Vec<Value>, DaemonError> {
    let levels = string_array(args.get("level"));
    let grep = optional_regex(args.get("grep"))?;
    let since = since_ms(args.get("since"))?;
    let limit = value_usize(args.get("limit")).unwrap_or(50);
    let mut out = Vec::new();
    for event in session.events.iter().rev() {
        if event.get("type").and_then(Value::as_str) != Some("console") {
            continue;
        }
        if let Some(since) = since {
            if event.get("ts").and_then(Value::as_i64).unwrap_or(0) < since {
                continue;
            }
        }
        if !levels.is_empty()
            && !levels
                .iter()
                .any(|l| Some(l.as_str()) == event.get("level").and_then(Value::as_str))
        {
            continue;
        }
        if let Some(re) = &grep {
            let text = event.get("text").and_then(Value::as_str).unwrap_or("");
            if !re.is_match(text) {
                continue;
            }
        }
        out.push(event.clone());
        if out.len() >= limit {
            break;
        }
    }
    out.reverse();
    Ok(out)
}

fn filter_network(session: &SessionBuffer, args: &Value) -> Result<Vec<Value>, DaemonError> {
    let method = args
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_uppercase);
    let status_filter = args
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string);
    let url = optional_regex(args.get("url"))?;
    let types = string_array(args.get("type"));
    let since = since_ms(args.get("since"))?;
    let limit = value_usize(args.get("limit")).unwrap_or(50);
    let mut out = Vec::new();
    for event in session.events.iter().rev() {
        if event.get("type").and_then(Value::as_str) != Some("network") {
            continue;
        }
        if let Some(since) = since {
            if event.get("ts").and_then(Value::as_i64).unwrap_or(0) < since {
                continue;
            }
        }
        if let Some(method) = &method {
            if event
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_uppercase)
                .as_deref()
                != Some(method.as_str())
            {
                continue;
            }
        }
        if let Some(filter) = &status_filter {
            if !status_matches(event.get("status").and_then(Value::as_i64), filter) {
                continue;
            }
        }
        if let Some(re) = &url {
            if !re.is_match(event.get("url").and_then(Value::as_str).unwrap_or("")) {
                continue;
            }
        }
        if !types.is_empty()
            && !types
                .iter()
                .any(|t| Some(t.as_str()) == event.get("resourceType").and_then(Value::as_str))
        {
            continue;
        }
        out.push(event.clone());
        if out.len() >= limit {
            break;
        }
    }
    out.reverse();
    Ok(out)
}

fn socket_path() -> Result<PathBuf> {
    if let Ok(path) = env::var("TETHER_SOCK") {
        return Ok(PathBuf::from(path));
    }
    if let Ok(dir) = env::var("XDG_RUNTIME_DIR") {
        return Ok(PathBuf::from(dir).join("tether.sock"));
    }
    let home = env::var("HOME").context("HOME unset and XDG_RUNTIME_DIR unset")?;
    Ok(PathBuf::from(home).join(".tether").join("tether.sock"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn get_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    obj.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{key} required"))
}

fn get_i64(obj: &Map<String, Value>, key: &str) -> Result<i64> {
    obj.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("{key} required"))
}

fn json_len(value: &Value) -> usize {
    serde_json::to_vec(value).map(|v| v.len()).unwrap_or(0)
}

fn yes_no(v: bool) -> &'static str {
    if v {
        "connected"
    } else {
        "disconnected"
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn optional_regex(value: Option<&Value>) -> Result<Option<Regex>, DaemonError> {
    let Some(pattern) = value.and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    Regex::new(pattern).map(Some).map_err(|_| DaemonError {
        code: "BAD_REQUEST",
        message: "invalid regex",
    })
}

fn value_usize(value: Option<&Value>) -> Option<usize> {
    value.and_then(Value::as_u64).map(|v| v as usize)
}

fn since_ms(value: Option<&Value>) -> Result<Option<i64>, DaemonError> {
    let Some(s) = value.and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let duration = parse_duration(s).ok_or(DaemonError {
        code: "BAD_REQUEST",
        message: "invalid duration",
    })?;
    Ok(Some(now_ms() - duration.as_millis() as i64))
}

fn parse_duration(input: &str) -> Option<Duration> {
    let (num, unit) = input.split_at(input.len().saturating_sub(1));
    let n: u64 = num.parse().ok()?;
    match unit {
        "s" => Some(Duration::from_secs(n)),
        "m" => Some(Duration::from_secs(n * 60)),
        "h" => Some(Duration::from_secs(n * 60 * 60)),
        _ => None,
    }
}

fn status_matches(status: Option<i64>, filter: &str) -> bool {
    let Some(status) = status else {
        return false;
    };
    match filter {
        "4xx" => (400..500).contains(&status),
        "5xx" => (500..600).contains(&status),
        _ => filter.parse::<i64>() == Ok(status),
    }
}

fn install_host(args: InstallHostArgs) -> Result<ExitCode> {
    let tether_bin = absolutize_path(args.binary.unwrap_or(env::current_exe()?))?;
    let tetherd = tether_bin
        .parent()
        .ok_or_else(|| anyhow!("binary has no parent directory"))?
        .join("tetherd");
    let manifest = native_host_manifest(&tetherd)?;
    let targets = native_host_dirs(args.browser)?;

    if args.dry_run {
        println!("tether: {}", tether_bin.display());
        println!("tetherd: {}", tetherd.display());
        for dir in &targets {
            println!(
                "manifest: {}",
                dir.join(format!("{NATIVE_HOST_NAME}.json")).display()
            );
        }
        println!("{manifest}");
        return Ok(ExitCode::SUCCESS);
    }

    if tetherd != tether_bin {
        let _ = fs::remove_file(&tetherd);
        unix_fs::symlink(&tether_bin, &tetherd)
            .with_context(|| format!("create symlink {}", tetherd.display()))?;
    }

    for dir in &targets {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        let path = dir.join(format!("{NATIVE_HOST_NAME}.json"));
        fs::write(&path, &manifest).with_context(|| format!("write {}", path.display()))?;
        println!("installed: {}", path.display());
    }
    println!("host '{NATIVE_HOST_NAME}' -> {}", tetherd.display());
    println!("allowed extension id: {EXTENSION_ID}");
    Ok(ExitCode::SUCCESS)
}

fn native_host_manifest(tetherd: &PathBuf) -> Result<String> {
    Ok(serde_json::to_string_pretty(&json!({
        "name": NATIVE_HOST_NAME,
        "description": "Tether daemon — native messaging host (receives console/network events from the extension).",
        "path": tetherd,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    }))?)
}

fn native_host_dirs(target: BrowserTarget) -> Result<Vec<PathBuf>> {
    let home = PathBuf::from(env::var("HOME").context("HOME unset")?);
    let mut dirs = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if matches!(target, BrowserTarget::All | BrowserTarget::Chrome) {
            dirs.push(home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"));
        }
        if matches!(target, BrowserTarget::All | BrowserTarget::Chromium) {
            dirs.push(home.join("Library/Application Support/Chromium/NativeMessagingHosts"));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if matches!(target, BrowserTarget::All | BrowserTarget::Chrome) {
            dirs.push(home.join(".config/google-chrome/NativeMessagingHosts"));
        }
        if matches!(target, BrowserTarget::All | BrowserTarget::Chromium) {
            dirs.push(home.join(".config/chromium/NativeMessagingHosts"));
        }
    }
    Ok(dirs)
}

fn absolutize_path(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn console_event(session: &str, text: &str) -> Value {
        json!({
            "type": "console",
            "ts": now_ms(),
            "tabId": 7,
            "sessionId": session,
            "level": "error",
            "text": text,
            "source": "console-api"
        })
    }

    fn network_event(session: &str, request_id: &str, status: i64) -> Value {
        json!({
            "type": "network",
            "ts": now_ms(),
            "tabId": 7,
            "sessionId": session,
            "requestId": request_id,
            "phase": "response",
            "method": "GET",
            "url": "https://example.test/api",
            "resourceType": "fetch",
            "status": status
        })
    }

    fn request_event(session: &str, request_id: &str) -> Value {
        json!({
            "type": "network",
            "ts": now_ms(),
            "tabId": 7,
            "sessionId": session,
            "requestId": request_id,
            "phase": "request",
            "method": "POST",
            "url": "https://example.test/api",
            "resourceType": "fetch",
            "requestHeaders": { "x-test": "1" }
        })
    }

    #[test]
    fn daemon_stamps_seq_and_tracks_session() {
        let mut state = DaemonState::default();
        state
            .ingest_events(vec![
                console_event("s1", "first"),
                console_event("s1", "second"),
            ])
            .unwrap();
        let session = state.resolve_session(Some("s1"), None).unwrap();
        assert_eq!(session.info.event_count, 2);
        assert_eq!(session.events[0].get("seq").unwrap(), 1);
        assert_eq!(session.events[1].get("seq").unwrap(), 2);
    }

    #[test]
    fn filters_console_and_network() {
        let mut state = DaemonState::default();
        state
            .ingest_events(vec![
                console_event("s1", "checkout failed"),
                console_event("s1", "ignored"),
                network_event("s1", "r1", 503),
                network_event("s1", "r2", 200),
            ])
            .unwrap();
        let session = state.resolve_session(Some("s1"), None).unwrap();
        let console = filter_console(session, &json!({"grep":"checkout","limit":10})).unwrap();
        let net = filter_network(session, &json!({"status":"5xx","limit":10})).unwrap();
        assert_eq!(console.len(), 1);
        assert_eq!(net.len(), 1);
        assert_eq!(net[0].get("requestId").unwrap(), "r1");
    }

    #[test]
    fn get_returns_all_request_phases() {
        let mut state = DaemonState::default();
        state
            .ingest_events(vec![
                request_event("s1", "r1"),
                network_event("s1", "r1", 503),
            ])
            .unwrap();
        let reply = handle_socket_request(
            &SocketRequest {
                v: 1,
                cmd: "get".into(),
                session: None,
                tab: None,
                args: json!({ "requestId": "r1" }),
            },
            &mut state,
        )
        .unwrap();
        let DaemonReply::Unary(value) = reply else {
            panic!("expected unary reply");
        };
        let phases = value.get("phases").and_then(Value::as_array).unwrap();
        assert_eq!(phases.len(), 2);
        assert_eq!(
            phases[0].get("phase").and_then(Value::as_str),
            Some("request")
        );
        assert_eq!(
            phases[1].get("phase").and_then(Value::as_str),
            Some("response")
        );
        assert!(phases[0].get("requestHeaders").is_some());
    }

    #[test]
    fn no_extension_is_distinct_from_no_session() {
        let mut state = DaemonState::default();
        let err = handle_socket_request(
            &SocketRequest {
                v: 1,
                cmd: "console".into(),
                session: None,
                tab: None,
                args: json!({}),
            },
            &mut state,
        )
        .unwrap_err();
        assert_eq!(err.code, "NO_EXTENSION");

        state.extension_connected = true;
        let err = handle_socket_request(
            &SocketRequest {
                v: 1,
                cmd: "console".into(),
                session: None,
                tab: None,
                args: json!({}),
            },
            &mut state,
        )
        .unwrap_err();
        assert_eq!(err.code, "NO_SESSION");
    }

    #[test]
    fn duration_parser() {
        assert_eq!(parse_duration("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_duration("5m"), Some(Duration::from_secs(300)));
        assert_eq!(parse_duration("1h"), Some(Duration::from_secs(3600)));
        assert_eq!(parse_duration("bogus"), None);
    }

    #[test]
    fn native_host_manifest_contains_extension_id_and_path() {
        let manifest = native_host_manifest(&PathBuf::from("/tmp/tetherd")).unwrap();
        let value: Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(
            value.get("name").and_then(Value::as_str),
            Some(NATIVE_HOST_NAME)
        );
        assert_eq!(
            value.get("path").and_then(Value::as_str),
            Some("/tmp/tetherd")
        );
        assert_eq!(
            value
                .get("allowed_origins")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str),
            Some("chrome-extension://lcbgiapgidfgdaohjbofohaokokcpefd/")
        );
    }
}
