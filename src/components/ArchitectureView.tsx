import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, FileCode, Play, XCircle } from 'lucide-react';
import type { ArchTreeNode } from '../types';

export const ArchitectureView: React.FC = () => {
  const [tree, setTree] = useState<ArchTreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('clippah_core/core/interfaces.py');
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{
    passed: boolean;
    duration_ms: number;
    output: string;
  } | null>(null);
  const [runningTests, setRunningTests] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/architecture/tree')
      .then((r) => r.json())
      .then((data: ArchTreeNode[]) => {
        setTree(data);
        if (data.length > 0 && !data.some((n) => n.path === selectedPath)) {
          setSelectedPath(data[0].path);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedPath) return;
    setLoadingFile(true);
    fetch(`/api/architecture/file?path=${encodeURIComponent(selectedPath)}`)
      .then((r) => r.json())
      .then((data) => {
        setFileContent(data.content || '');
        setLoadingFile(false);
      })
      .catch(() => setLoadingFile(false));
  }, [selectedPath]);

  const runUnitTests = async () => {
    setRunningTests(true);
    try {
      const res = await fetch('/api/architecture/test', { method: 'POST' });
      const data = await res.json();
      setTestResult(data);
    } finally {
      setRunningTests(false);
    }
  };

  const layerLabels: Record<ArchTreeNode['layer'], string> = {
    core: 'Pure Domain',
    adapter: 'Desktop Adapter',
    ui: 'UI / Sidecar',
    tests: 'Unit Tests',
    root: 'Packaging',
  };

  return (
    <div className="space-y-5">
      {/* Summary & Action Strip */}
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Modular Python Architecture & Desktop/Android Packaging Blueprint
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Live files on disk in <code className="text-slate-300">clippah_core/</code>. Pure domain schemas,
            timestamp grounding, SRT/ASS captions, and SQLite queue have zero UI or binary imports.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runUnitTests}
            disabled={runningTests}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            {runningTests ? 'Running Python Tests...' : 'Run Core Python Tests'}
          </button>
          <a
            href="/api/architecture/bundle"
            download="clippah_core_starter.zip"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Download Starter Bundle (.zip)
          </a>
        </div>
      </div>

      {/* Live Test Output */}
      {testResult && (
        <div
          className={`bg-[#0B0F17] border rounded-lg p-4 space-y-2 ${
            testResult.passed ? 'border-emerald-500/40' : 'border-rose-500/40'
          }`}
        >
          <div className="flex items-center justify-between text-xs">
            <div className="inline-flex items-center gap-2 font-semibold">
              {testResult.passed ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-emerald-400">All Python core unit tests passed</span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-rose-400" />
                  <span className="text-rose-400">Unit tests reported errors</span>
                </>
              )}
            </div>
            <span className="font-mono tabular-nums text-slate-400">
              {testResult.duration_ms} ms
            </span>
          </div>
          <pre className="text-[11px] font-mono text-slate-300 bg-[#111724] border border-slate-800 rounded p-3 overflow-x-auto">
            {testResult.output}
          </pre>
        </div>
      )}

      {/* Tree + Source Code Viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <div className="lg:col-span-4 bg-[#111724] border border-slate-800/90 rounded-lg overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-800 text-xs font-semibold text-slate-200">
            Module Layout ({tree.length} files)
          </div>
          <div className="divide-y divide-slate-800/50 max-h-[560px] overflow-y-auto">
            {tree.map((node) => {
              const active = node.path === selectedPath;
              return (
                <button
                  key={node.path}
                  type="button"
                  onClick={() => setSelectedPath(node.path)}
                  className={`w-full text-left px-3.5 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                    active ? 'bg-blue-950/40 text-white' : 'hover:bg-slate-800/40 text-slate-300'
                  }`}
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <FileCode className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-xs font-mono truncate">{node.path.replace('clippah_core/', '')}</span>
                  </div>
                  <span className="text-[11px] text-slate-500 whitespace-nowrap shrink-0">
                    {layerLabels[node.layer]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-8 bg-[#111724] border border-slate-800/90 rounded-lg overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
            <span className="text-xs font-mono text-slate-200 truncate">{selectedPath}</span>
            <span className="text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
              {fileContent.split('\n').length} lines
            </span>
          </div>
          <pre className="p-4 text-[12px] leading-relaxed font-mono text-slate-200 bg-[#0B0F17] overflow-auto max-h-[560px] flex-1">
            {loadingFile ? 'Loading module source...' : fileContent}
          </pre>
        </div>
      </div>

      {/* Packaging Fit Matrix */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-100">PyInstaller Native Desktop</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Bundle <code className="text-slate-300">clippah_core/ui/desktop_pyqt6.py</code> with{' '}
            <code className="text-slate-300">--onedir</code>, shipping static <code className="text-slate-300">ffmpeg</code> and{' '}
            <code className="text-slate-300">yt-dlp</code> binaries inside <code className="text-slate-300">Resources/bin/</code>.
            Background <code className="text-slate-300">QThread</code> workers keep UI painting at 60fps during Whisper inference.
          </p>
        </div>

        <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-100">Tauri v2 Sidecar Split</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Compile this React workspace into <code className="text-slate-300">dist/</code> as the Tauri WebView frontend and compile{' '}
            <code className="text-slate-300">clippah_core/ui/tauri_sidecar.py</code> into a single{' '}
            <code className="text-slate-300">externalBin</code> sidecar listening on <code className="text-slate-300">127.0.0.1:43111</code>.
          </p>
        </div>

        <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-100">Android Adaptation Seam</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Reuse <code className="text-slate-300">clippah_core/core/</code> directly via Chaquopy (or port the pure Pydantic contracts to Kotlin{' '}
            <code className="text-slate-300">@Serializable</code> classes). Swap desktop adapters for{' '}
            <code className="text-slate-300">whisper.cpp</code> JNI + <code className="text-slate-300">Media3 Transformer</code>.
          </p>
        </div>
      </div>
    </div>
  );
};
