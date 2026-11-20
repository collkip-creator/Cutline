import React from 'react';

const SUBSYSTEM_TRADEOFFS = [
  {
    subsystem: 'ASR Transcription (Transcriber)',
    desktopDefault: 'faster-whisper small / medium (CTranslate2 int8/fp16) + Silero VAD',
    desktopFootprint: '1.2 GB – 4.5 GB RAM · 8x–20x realtime on Apple Silicon / RTX GPU',
    androidTarget: 'whisper.cpp JNI (ARM NEON + Vulkan/Hexagon NPU) running tiny.en / base.en Q5_0',
    androidFootprint: '140 MB – 380 MB RAM · 1.5x–3x realtime on Snapdragon 8 Gen 2/3',
    mitigation:
      'Chunk audio into 30s VAD windows via AudioRecord/MediaExtractor so memory stays flat; cache Transcript JSON immediately after each chunk.',
  },
  {
    subsystem: 'Highlight Reasoning (HighlightEngine)',
    desktopDefault: 'Local Ollama (qwen2.5:14b or llama3.1:8b) with strict JSON schema',
    desktopFootprint: '5.5 GB – 10.5 GB VRAM/Unified RAM · 25–65 tok/s',
    androidTarget: 'LAN Ollama endpoint (desktop offload) OR MediaPipe / llama.cpp 1.5B–3B Q4_K_M + heuristic pre-filter',
    androidFootprint: '1.1 GB – 2.2 GB RAM · Do NOT hold ASR and LLM weights resident simultaneously',
    mitigation:
      'Enforce sequential stage lifecycle: unload Whisper model & GC before loading LLM weights, or allow pointing base_url to a LAN workstation.',
  },
  {
    subsystem: 'Video Cutting & 9:16 Reframing (VideoProcessor)',
    desktopDefault: 'Subprocess FFmpeg (libx264 -preset veryfast or -c copy) + libass subtitle burn',
    desktopFootprint: '250 MB – 650 MB RAM · Full filtergraph flexibility',
    androidTarget: 'AndroidX Media3 Transformer (hardware MediaCodec H.264/HEVC + GL Crop/OverlayEffect)',
    androidFootprint: '90 MB – 180 MB RAM · Hardware-accelerated, zero GPL/LGPL binary licensing friction',
    mitigation:
      'Avoid CPU libx264 software encoding on mobile (causes thermal throttling in <90s and 4x battery drain). Use Media3 GlEffect for 9:16 crop & bitmap subtitle overlay.',
  },
  {
    subsystem: 'Media Ingestion (MediaDownloader)',
    desktopDefault: 'Local file picker + yt-dlp subprocess (auto-merges DASH video+audio)',
    desktopFootprint: 'Streaming disk write · Negligible RAM',
    androidTarget: 'Android Storage Access Framework (ContentResolver URI) + Chaquopy yt-dlp / WorkManager',
    androidFootprint: 'Scoped storage compliant · Must stream via FileDescriptor without full-file duplication',
    mitigation:
      'Compute SHA-256 incrementally in 1 MB chunks; never load whole 4K source MP4s into memory.',
  },
  {
    subsystem: 'Publish Queue & Background Execution',
    desktopDefault: 'SQLite PublishQueueStore + PyQt6 QThread / FastAPI background task',
    desktopFootprint: '< 25 MB RAM',
    androidTarget: 'Same SQLite schema (or Room mirror) driven by Android WorkManager with NetworkType.CONNECTED constraint',
    androidFootprint: '< 20 MB RAM · Survives app kill & Doze mode',
    mitigation:
      'Use foreground service notification for active exports >10s so Android OS does not kill the render pipeline when backgrounded.',
  },
];

export const HardwareTradeoffsView: React.FC = () => {
  return (
    <div className="space-y-5">
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4">
        <h2 className="text-base font-semibold text-slate-100">
          Desktop to Android Hardware, RAM & Thermal Trade-offs
        </h2>
        <p className="text-xs text-slate-400 mt-1 max-w-3xl leading-relaxed">
          Mid-range Android devices (6 GB–8 GB physical RAM) enforce strict per-app heap and native allocation limits
          (typically 2.5 GB–3.5 GB before <code className="text-slate-300">lmkd</code> kills backgrounded processes).
          Below is the exact subsystem mapping required to port <code className="text-slate-300">clippah_core</code> cleanly.
        </p>
      </div>

      {/* Memory Budget Strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4">
          <div className="text-xs text-slate-400">Desktop Peak Budget (16–32 GB RAM)</div>
          <div className="text-2xl font-display font-semibold text-slate-100 font-mono tabular-nums mt-1">
            8.5 – 14.0 GB
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Whisper small + Ollama 14B resident concurrently with FFmpeg subprocesses
          </div>
        </div>

        <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4">
          <div className="text-xs text-slate-400">Android Safe Ceiling (6–8 GB Device)</div>
          <div className="text-2xl font-display font-semibold text-amber-300 font-mono tabular-nums mt-1">
            &le; 1.8 GB
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Sequential model loading: unload ASR before LLM; hardware MediaCodec export
          </div>
        </div>

        <div className="bg-[#111724] border border-slate-800/90 rounded-lg p-4">
          <div className="text-xs text-slate-400">Transcript Cache Hit Cost</div>
          <div className="text-2xl font-display font-semibold text-emerald-400 font-mono tabular-nums mt-1">
            0 ms ASR
          </div>
          <div className="text-xs text-slate-400 mt-1">
            SHA-256 JSON cache skips Whisper entirely on prompt iteration or export tweaks
          </div>
        </div>
      </div>

      {/* Detailed Comparison Matrix */}
      <div className="bg-[#111724] border border-slate-800/90 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-[#0D121D] text-[11px] font-medium text-slate-400">
                <th className="py-3 px-4 min-w-[180px]">Subsystem</th>
                <th className="py-3 px-4 min-w-[230px]">Desktop Default</th>
                <th className="py-3 px-4 min-w-[240px]">Android Replacement</th>
                <th className="py-3 px-4 min-w-[260px]">Architectural Mitigation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {SUBSYSTEM_TRADEOFFS.map((row) => (
                <tr key={row.subsystem} className="align-top hover:bg-slate-800/25">
                  <td className="py-3.5 px-4 font-semibold text-slate-100">
                    {row.subsystem}
                  </td>
                  <td className="py-3.5 px-4 space-y-1">
                    <div className="text-slate-200">{row.desktopDefault}</div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-400">
                      {row.desktopFootprint}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 space-y-1">
                    <div className="text-blue-300">{row.androidTarget}</div>
                    <div className="text-[11px] font-mono tabular-nums text-amber-300/90">
                      {row.androidFootprint}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-slate-300 leading-relaxed">
                    {row.mitigation}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
