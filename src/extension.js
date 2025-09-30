const vscode = require("vscode");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function activate(context) {
  let panel;
  let timer;
  let lastDoc = null;

  const ensurePanel = () => {
    if (panel) return panel;
    panel = vscode.window.createWebviewPanel(
      "liveAsm",
      "Live ASM",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      }
    );
    panel.webview.html = getHtml(context, panel.webview);

    panel.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      const doc = vscode.window.activeTextEditor?.document ?? lastDoc;

      if (msg.type === "setSyntax") {
        context.workspaceState.update("liveAsm.syntax", msg.syntax);
        if (doc) compileAndPost(doc);
      }
      if (msg.type === "setOpt") {
        context.workspaceState.update("liveAsm.opt", msg.opt);
        if (doc) compileAndPost(doc);
      }
      if (msg.type === "setRaw") {
        context.workspaceState.update("liveAsm.raw", !!msg.raw);
        if (doc) compileAndPost(doc);
      }
      if (msg.type === "requestRebuild") {
        if (doc) compileAndPost(doc);
      }
    });

    panel.onDidDispose(() => (panel = undefined));
    return panel;
  };

  const debounced =
    (fn, ms) =>
    (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };

  const debouncedBuild = debounced(
    (doc) => compileAndPost(doc),
    vscode.workspace.getConfiguration("liveAsm").get("debounceMs") || 500
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("liveAsm.open", () => {
      ensurePanel();
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) {
        lastDoc = doc;
        debouncedBuild(doc);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      lastDoc = e.document;
      debouncedBuild(e.document);
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e?.document) {
        lastDoc = e.document;
        debouncedBuild(e.document);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!panel || !e?.textEditor?.document) return;
      const line = e.selections?.[0]?.active?.line ?? 0;
      panel.webview.postMessage({ type: "cursor", line: line + 1 });
    })
  );

  async function compileAndPost(doc) {
    if (!panel) return;
    if (!doc || !["c", "cpp"].includes(doc.languageId)) return;

    const cfg = vscode.workspace.getConfiguration("liveAsm");
    const configured = cfg.get("compilerPath") || "gcc";
    const extra = (cfg.get("extraArgs") || "").trim();

    const syntax = context.workspaceState.get("liveAsm.syntax") || "intel"; // intel|att
    const opt = context.workspaceState.get("liveAsm.opt") || "O0"; // O0..O3
    const raw = !!context.workspaceState.get("liveAsm.raw");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "liveasm-"));
    const cPath = path.join(
      tmpDir,
      doc.languageId === "cpp" ? "live.cpp" : "live.c"
    );
    const sPath = path.join(tmpDir, "live.s");
    fs.writeFileSync(cPath, doc.getText(), "utf8");

    const { exe, isMSVC } = resolveCompiler(configured, doc.languageId);

    let args = [];
    if (isMSVC) {
      const langSwitch = doc.languageId === "cpp" ? "/TP" : "/TC";
      args = ["/nologo", "/c", langSwitch, cPath, "/FA", `/Fa:${sPath}`];
      if (!raw) args.splice(4, 0, "/FAs", "/Zi");
      if (extra) args.push(...splitArgs(extra));
      const optMap = { O0: "/Od", O1: "/O1", O2: "/O2", O3: "/Ox" };
      args.push(optMap[opt] || "/Od");
    } else {
      args = ["-S", cPath, "-o", sPath];
      if (!raw) args.splice(1, 0, "-g", "-fverbose-asm");
      if (extra) args.push(...splitArgs(extra));
      args.push(`-${opt}`);
      args.push(syntax === "intel" ? "-masm=intel" : "-masm=att");
      if (raw) args.push("-fno-asynchronous-unwind-tables", "-fno-ident");
    }

    panel.webview.postMessage({
      type: "status",
      status: `${exe} ${args.join(" ")}`,
    });

    const child = spawn(exe, args, { shell: process.platform === "win32" });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", () => {
      try {
        if (fs.existsSync(sPath)) {
          const asm = fs.readFileSync(sPath, "utf8");
          panel.webview.postMessage({ type: "asm", asm });
        } else {
          panel.webview.postMessage({
            type: "error",
            error: stderr || "Build failed.",
          });
        }
      } catch (e) {
        panel.webview.postMessage({ type: "error", error: String(e) });
      }
    });
  }
}

function resolveCompiler(configured, langId) {
  const lower = configured.toLowerCase();
  const isCl = /(^|[\\/])cl(\.exe)?$/.test(lower);
  const isClangCl = /(^|[\\/])clang-cl(\.exe)?$/.test(lower);
  if (isCl || isClangCl) return { exe: configured, isMSVC: true };

  const isGcc = /(^|[\\/])gcc(\.exe)?$/.test(lower);
  const isGpp = /(^|[\\/])g\+\+(\.exe)?$/.test(lower);
  if (isGcc && langId === "cpp")
    return {
      exe: configured.replace(/gcc(\.exe)?$/i, (m) => m.replace("gcc", "g++")),
      isMSVC: false,
    };
  if (isGpp && langId === "c")
    return {
      exe: configured.replace(/g\+\+(\.exe)?$/i, (m) =>
        m.replace("g++", "gcc")
      ),
      isMSVC: false,
    };

  const isClang = /(^|[\\/])clang(\.exe)?$/.test(lower);
  const isClangpp = /(^|[\\/])clang\+\+(\.exe)?$/.test(lower);
  if (isClang && langId === "cpp")
    return { exe: configured + "++", isMSVC: false };
  if (isClangpp && langId === "c")
    return { exe: configured.replace(/\+\+(\.exe)?$/i, ""), isMSVC: false };

  return { exe: configured, isMSVC: false };
}

function splitArgs(s) {
  const re = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] || m[2] || m[0]);
  return out;
}

function getHtml(context, webview) {
  const dist = vscode.Uri.joinPath(context.extensionUri, "media", "dist");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, "bundle.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, "style.css"));

  const csp = [
    "default-src 'none';",
    `img-src ${webview.cspSource} data:;`,
    `script-src ${webview.cspSource};`,
    `style-src ${webview.cspSource} 'unsafe-inline';`,
  ].join(" ");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${css}" />
  <title>Live ASM</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${js}"></script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
