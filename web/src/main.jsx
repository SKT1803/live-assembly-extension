import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const vscode = globalThis.acquireVsCodeApi?.() ?? { postMessage: () => {} };

function Toolbar({
  filter,
  setFilter,
  syntax,
  setSyntax,
  opt,
  setOpt,
  viewMode,
  setViewMode,
  hideDirectives,
  setHideDirectives,
  onCopy,
  onRebuild,
  status,
}) {
  const hideDisabled = viewMode === "annotated";
  return (
    <div className="toolbar">
      <strong>Live ASM</strong>

      <input
        className="search"
        placeholder="filter / symbol"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <select value={syntax} onChange={(e) => setSyntax(e.target.value)}>
        <option value="intel">Intel</option>
        <option value="att">AT&amp;T</option>
      </select>

      <select value={opt} onChange={(e) => setOpt(e.target.value)}>
        <option value="O0">-O0</option>
        <option value="O1">-O1</option>
        <option value="O2">-O2</option>
        <option value="O3">-O3</option>
      </select>

      <select value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
        <option value="instructions">Instructions only</option>
        <option value="annotated">Annotated (full)</option>
      </select>

      <label title={hideDisabled ? "Full (annotated) modda kapalıdır" : ""}>
        <input
          type="checkbox"
          checked={hideDirectives}
          onChange={(e) => setHideDirectives(e.target.checked)}
          disabled={hideDisabled}
        />{" "}
        Hide directives
      </label>

      <button onClick={onCopy}>Copy</button>
      <button onClick={onRebuild} title="Force rebuild">
        Rebuild
      </button>

      {status && <span className="status">{status}</span>}
    </div>
  );
}

/* ───────────── Helpers ───────────── */
const isLabel = (s) => /^\s*[._A-Za-z]\w*:\s*$/.test(s);

const isBoilerplateLabel = (s) =>
  /^\s*\.(?:L(?:text|etext)\d*|LFB\d+|LFE\d+|Ldebug_[A-Za-z0-9_]+|LASF\d+):\s*$/i.test(
    s
  );

const isDirectiveLine = (s) => {
  if (isLabel(s)) return false;
  const t = s.trimStart();
  return t.startsWith(".") && !/^\.\w+\s*:\s*$/.test(t);
};

const isInstruction = (s0) => {
  const s = s0.trim();
  if (!s || s.startsWith(".")) return false;
  if (/^\s*[#;]/.test(s)) return false;
  return /^(?:[._A-Za-z]\w*:\s*)?(?:lock\s+)?[A-Za-z]{2,8}\b(?!:)/.test(s);
};

function App() {
  const [asm, setAsm] = useState("// Assembly waiting…");
  const [status, setStatus] = useState("");

  const [filter, setFilter] = useState("");
  const [syntax, setSyntax] = useState("intel");
  const [opt, setOpt] = useState("O0");

  // extension a “raw” bilgisi gönderiliyor; UI da yok
  const [raw] = useState(false);

  const [viewMode, setViewMode] = useState("instructions"); // "instructions" | "annotated"
  const [hideDirectives, setHideDirectives] = useState(true);

  const [cursorLine, setCursorLine] = useState(1);
  const preRef = useRef(null);

  useEffect(() => {
    const onMsg = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "asm") {
        setAsm(msg.asm);
        // statusı temizlemiyoruz; toolbar'da komut kalsın
      }
      if (msg.type === "error") {
        setAsm(`// ERROR\n${msg.error}`);
        setStatus("Build failed");
      }
      if (msg.type === "cursor") setCursorLine(msg.line);
      if (msg.type === "status") setStatus(msg.status);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    vscode.postMessage({ type: "setSyntax", syntax });
  }, [syntax]);
  useEffect(() => {
    vscode.postMessage({ type: "setOpt", opt });
  }, [opt]);
  useEffect(() => {
    vscode.postMessage({ type: "setRaw", raw });
  }, [raw]);

  useEffect(() => {
    if (viewMode === "annotated" && hideDirectives) {
      setHideDirectives(false);
    }
  }, [viewMode]);

  const origHighlightSet = useMemo(() => {
    const srcLine = cursorLine;
    const lines = asm.replace(/\r\n?/g, "\n").split("\n");
    if (!lines.length) return new Set();

    const pats = [
      new RegExp(String.raw`^\s*\.loc\s+\d+\s+${srcLine}\b`),
      new RegExp(String.raw`^\s*[#;].*?\bline\s+${srcLine}\b`, "i"),
      new RegExp(String.raw`^\s*[#;]\s*${srcLine}\b`),
    ];

    // 1. anchor
    let anchor = -1;
    for (let i = 0; i < lines.length; i++) {
      if (pats.some((p) => p.test(lines[i]))) {
        anchor = i;
        break;
      }
    }
    if (anchor === -1) return new Set();

    const stopRe = /^\s*\.(?:loc|file|text|section)\b/i;
    const set = new Set();
    for (let j = anchor + 1; j < lines.length; j++) {
      if (stopRe.test(lines[j])) break;
      set.add(j);
    }
    set.add(anchor);
    return set;
  }, [asm, cursorLine]);

  const { displayLines, displayToOrig } = useMemo(() => {
    const asmLF = asm.replace(/\r\n?/g, "\n");
    const orig = asmLF.split("\n");

    const out = [];
    const map = [];
    const needle = filter.trim().toLowerCase();

    for (let i = 0; i < orig.length; i++) {
      let line = orig[i];

      // Hide directives: SADECE annotated değilken uygula
      if (viewMode !== "annotated" && hideDirectives) {
        if (isDirectiveLine(line)) continue;
        line = line.replace(/\s*[#;].*$/, ""); // satır sonu yorumları sil
        if (/^\s*$/.test(line)) continue;
      }

      // Instructions görünümü: gerçek talimat + gerekli label'lar
      if (viewMode === "instructions") {
        if (isLabel(line)) {
          if (isBoilerplateLabel(line)) continue;
        } else if (!isInstruction(line)) {
          continue;
        }
      }

      if (needle && !line.toLowerCase().includes(needle)) continue;

      out.push(line);
      map.push(i);
    }

    return { displayLines: out, displayToOrig: map };
  }, [asm, viewMode, hideDirectives, filter]);

  const highlightIdxSet = useMemo(() => {
    if (!origHighlightSet.size) return new Set();
    const s = new Set();
    displayToOrig.forEach((origIdx, dispIdx) => {
      if (origHighlightSet.has(origIdx)) s.add(dispIdx);
    });
    return s;
  }, [displayToOrig, origHighlightSet]);

  useEffect(() => {
    if (!preRef.current) return;

    const container = preRef.current;
    const firstHL = container.querySelector(".asm-line.highlight");

    if (firstHL) {
      const elTop = firstHL.offsetTop;
      const elH = firstHL.offsetHeight || 18;
      const targetTop = elTop - (container.clientHeight - elH) / 2;
      container.scrollTop = Math.max(0, targetTop);
      return;
    }

    const lines = asm.split("\n");
    const target = cursorLine;
    let bestIdx = -1;
    const pats = [
      new RegExp(String.raw`\.loc\s+\d+\s+${target}\b`),
      new RegExp(String.raw`[#;].*?\bline\s+${target}\b`, "i"),
      new RegExp(String.raw`[#;]\s*${target}\b`),
    ];
    for (let i = 0; i < lines.length; i++) {
      if (pats.some((p) => p.test(lines[i]))) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx < 0) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/\.(loc|file)\b/.test(lines[i])) {
          bestIdx = i;
          break;
        }
      }
    }
    if (bestIdx >= 0) {
      const approxLineHeight = 18;
      container.scrollTop = Math.max(0, approxLineHeight * (bestIdx - 5));
    }
  }, [asm, cursorLine, displayLines.length, highlightIdxSet]);

  const onCopy = () => navigator.clipboard?.writeText(displayLines.join("\n"));
  const onRebuild = () => vscode.postMessage({ type: "requestRebuild" });

  return (
    <div className="wrap">
      <Toolbar
        filter={filter}
        setFilter={setFilter}
        syntax={syntax}
        setSyntax={setSyntax}
        opt={opt}
        setOpt={setOpt}
        viewMode={viewMode}
        setViewMode={setViewMode}
        hideDirectives={hideDirectives}
        setHideDirectives={setHideDirectives}
        onCopy={onCopy}
        onRebuild={onRebuild}
        status={status}
      />
      <pre className="output" ref={preRef}>
        {displayLines.map((l, i) => (
          <div
            key={i}
            className={`asm-line${highlightIdxSet.has(i) ? " highlight" : ""}`}
          >
            {l}
          </div>
        ))}
      </pre>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
