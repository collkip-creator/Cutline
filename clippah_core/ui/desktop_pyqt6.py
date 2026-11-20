"""
Native PyQt6 Desktop UI with background QThread workers.

Zero business logic lives inside widgets: all transcription, grounding,
captioning, rendering, and queue state are delegated to `clippah_core.core`.
Package with PyInstaller (`pyinstaller --windowed --name CutlineStudio clippah_core/ui/desktop_pyqt6.py`).
"""

from __future__ import annotations

from pathlib import Path
import sys
from typing import List, Optional

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ..adapters.desktop_ffmpeg import FFmpegVideoProcessor
from ..adapters.desktop_ollama import OllamaHighlightEngine
from ..adapters.desktop_whisper import FasterWhisperTranscriber
from ..adapters.desktop_ytdlp import DesktopMediaDownloader
from ..adapters.social_adapters import build_default_publishers
from ..core.cache import TranscriptCache
from ..core.grounding import snap_clip_to_words
from ..core.pipeline import ClippahPipeline
from ..core.queue import PublishQueueStore
from ..core.schemas import (
    AspectRatio,
    ClipCandidate,
    EncodeMode,
    ExportSpec,
    MediaAsset,
    PublishPlatform,
    Transcript,
)


class IngestAndAnalyzeWorker(QThread):
    progress = pyqtSignal(int, str)
    finished_ok = pyqtSignal(object, object, list, bool)
    failed = pyqtSignal(str)

    def __init__(self, pipeline: ClippahPipeline, source: str, prompt: str) -> None:
        super().__init__()
        self.pipeline = pipeline
        self.source = source
        self.prompt = prompt

    def run(self) -> None:
        try:
            def _cb(pct: float, msg: str) -> None:
                self.progress.emit(int(pct * 100), msg)

            asset, transcript, cache_hit = self.pipeline.ingest_and_transcribe(
                self.source, on_progress=_cb
            )
            self.progress.emit(85, "Extracting grounded highlights...")
            clips = self.pipeline.find_clips(transcript, self.prompt)
            self.progress.emit(100, "Ready")
            self.finished_ok.emit(asset, transcript, clips, cache_hit)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))


class ExportWorker(QThread):
    progress = pyqtSignal(int, str)
    finished_ok = pyqtSignal(object)
    failed = pyqtSignal(str)

    def __init__(
        self,
        pipeline: ClippahPipeline,
        asset: MediaAsset,
        transcript: Transcript,
        spec: ExportSpec,
    ) -> None:
        super().__init__()
        self.pipeline = pipeline
        self.asset = asset
        self.transcript = transcript
        self.spec = spec

    def run(self) -> None:
        try:
            res = self.pipeline.export_clip(
                self.asset,
                self.transcript,
                self.spec,
                on_progress=lambda p, m: self.progress.emit(int(p * 100), m),
            )
            self.finished_ok.emit(res)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))


class CutlineMainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Cutline Studio — Local-First Clipping Workstation")
        self.resize(1360, 860)

        data_root = Path.home() / ".cutline_studio"
        self.video_processor = FFmpegVideoProcessor()
        self.pipeline = ClippahPipeline(
            downloader=DesktopMediaDownloader(self.video_processor),
            transcriber=FasterWhisperTranscriber(model_size="small", compute_type="int8"),
            highlight_engine=OllamaHighlightEngine(base_url="http://localhost:11434", model="qwen2.5:14b"),
            video_processor=self.video_processor,
            cache=TranscriptCache(data_root / "transcript_cache"),
            workspace_dir=data_root / "workspace",
        )
        self.queue_store = PublishQueueStore(data_root / "publish_queue.db")
        self.publishers = build_default_publishers()

        self.current_asset: Optional[MediaAsset] = None
        self.current_transcript: Optional[Transcript] = None
        self.clips: List[ClipCandidate] = []
        self._worker: Optional[QThread] = None

        self._build_ui()

    def _build_ui(self) -> None:
        tabs = QTabWidget()
        self.setCentralWidget(tabs)

        # Tab 1: Clipping Studio
        studio = QWidget()
        studio_layout = QVBoxLayout(studio)

        source_row = QHBoxLayout()
        self.source_input = QLineEdit()
        self.source_input.setPlaceholderText("Local video path (.mp4/.mov) or streaming URL...")
        browse_btn = QPushButton("Browse File")
        browse_btn.clicked.connect(self._browse_file)
        run_btn = QPushButton("Transcribe & Extract")
        run_btn.clicked.connect(self._run_ingest)
        source_row.addWidget(QLabel("Source:"))
        source_row.addWidget(self.source_input, 1)
        source_row.addWidget(browse_btn)
        source_row.addWidget(run_btn)
        studio_layout.addLayout(source_row)

        prompt_row = QHBoxLayout()
        self.prompt_input = QLineEdit("High-retention hooks, strong claims, and concise takeaways")
        prompt_row.addWidget(QLabel("Highlight Brief:"))
        prompt_row.addWidget(self.prompt_input, 1)
        studio_layout.addLayout(prompt_row)

        self.progress_bar = QProgressBar()
        self.status_label = QLabel("Idle")
        prog_row = QHBoxLayout()
        prog_row.addWidget(self.progress_bar, 1)
        prog_row.addWidget(self.status_label)
        studio_layout.addLayout(prog_row)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        self.clip_table = QTableWidget(0, 6)
        self.clip_table.setHorizontalHeaderLabels(["ID", "Title", "Start", "End", "Score", "Hook"])
        self.clip_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.clip_table.cellChanged.connect(self._on_clip_cell_edited)
        splitter.addWidget(self.clip_table)

        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        self.transcript_view = QTextEdit()
        self.transcript_view.setReadOnly(True)
        right_layout.addWidget(QLabel("Cached Transcript & Word Timestamps"))
        right_layout.addWidget(self.transcript_view, 1)

        export_row = QHBoxLayout()
        self.aspect_combo = QComboBox()
        self.aspect_combo.addItems(["9:16", "16:9"])
        self.encode_combo = QComboBox()
        self.encode_combo.addItems(["reencode", "stream_copy"])
        self.burn_check = QCheckBox("Burn ASS Captions")
        self.burn_check.setChecked(True)
        snap_btn = QPushButton("Snap Selected to Words")
        snap_btn.clicked.connect(self._snap_selected)
        export_btn = QPushButton("Export Selected Clip")
        export_btn.clicked.connect(self._export_selected)
        queue_btn = QPushButton("Queue for Publish")
        queue_btn.clicked.connect(self._queue_selected)
        export_row.addWidget(self.aspect_combo)
        export_row.addWidget(self.encode_combo)
        export_row.addWidget(self.burn_check)
        export_row.addWidget(snap_btn)
        export_row.addWidget(export_btn)
        export_row.addWidget(queue_btn)
        right_layout.addLayout(export_row)

        splitter.addWidget(right_panel)
        splitter.setSizes([740, 600])
        studio_layout.addWidget(splitter, 1)

        tabs.addTab(studio, "Clip Studio")

        # Tab 2: Publish Queue
        queue_tab = QWidget()
        q_layout = QVBoxLayout(queue_tab)
        self.queue_table = QTableWidget(0, 5)
        self.queue_table.setHorizontalHeaderLabels(["Job ID", "Clip", "Platform", "Status", "Scheduled"])
        self.queue_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        q_actions = QHBoxLayout()
        refresh_q = QPushButton("Refresh Queue")
        refresh_q.clicked.connect(self._refresh_queue_table)
        process_q = QPushButton("Publish Due Jobs")
        process_q.clicked.connect(self._process_queue)
        q_actions.addWidget(refresh_q)
        q_actions.addWidget(process_q)
        q_actions.addStretch(1)
        q_layout.addLayout(q_actions)
        q_layout.addWidget(self.queue_table, 1)
        tabs.addTab(queue_tab, "Publish Queue")
        self._refresh_queue_table()

    def _browse_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Select Video", "", "Video Files (*.mp4 *.mov *.mkv *.webm)")
        if path:
            self.source_input.setText(path)

    def _run_ingest(self) -> None:
        source = self.source_input.text().strip()
        if not source:
            return
        worker = IngestAndAnalyzeWorker(self.pipeline, source, self.prompt_input.text().strip())
        worker.progress.connect(lambda p, m: (self.progress_bar.setValue(p), self.status_label.setText(m)))
        worker.finished_ok.connect(self._on_ingest_done)
        worker.failed.connect(lambda err: QMessageBox.critical(self, "Pipeline Error", err))
        self._worker = worker
        worker.start()

    def _on_ingest_done(self, asset: MediaAsset, transcript: Transcript, clips: List[ClipCandidate], cache_hit: bool) -> None:
        self.current_asset = asset
        self.current_transcript = transcript
        self.clips = clips
        self.status_label.setText("Transcript cache hit (0ms)" if cache_hit else "Transcribed & cached")
        self.transcript_view.setPlainText(
            "\n".join(f"[{s.start_sec:.2f} - {s.end_sec:.2f}] {s.text}" for s in transcript.segments)
        )
        self._populate_clip_table()

    def _populate_clip_table(self) -> None:
        self.clip_table.blockSignals(True)
        self.clip_table.setRowCount(len(self.clips))
        for row, c in enumerate(self.clips):
            self.clip_table.setItem(row, 0, QTableWidgetItem(c.id))
            self.clip_table.setItem(row, 1, QTableWidgetItem(c.title))
            self.clip_table.setItem(row, 2, QTableWidgetItem(f"{c.start_sec:.2f}"))
            self.clip_table.setItem(row, 3, QTableWidgetItem(f"{c.end_sec:.2f}"))
            self.clip_table.setItem(row, 4, QTableWidgetItem(f"{c.hook_score:.1f}"))
            self.clip_table.setItem(row, 5, QTableWidgetItem(c.caption_hook))
        self.clip_table.blockSignals(False)

    def _on_clip_cell_edited(self, row: int, col: int) -> None:
        if row >= len(self.clips):
            return
        c = self.clips[row]
        val = self.clip_table.item(row, col).text()
        data = c.model_dump()
        if col == 1:
            data["title"] = val
        elif col == 2:
            data["start_sec"] = float(val)
        elif col == 3:
            data["end_sec"] = float(val)
        elif col == 4:
            data["hook_score"] = float(val)
        elif col == 5:
            data["caption_hook"] = val
        self.clips[row] = ClipCandidate.model_validate(data)

    def _snap_selected(self) -> None:
        row = self.clip_table.currentRow()
        if row < 0 or self.current_transcript is None:
            return
        self.clips[row] = snap_clip_to_words(self.clips[row], self.current_transcript)
        self._populate_clip_table()

    def _export_selected(self) -> None:
        row = self.clip_table.currentRow()
        if row < 0 or self.current_asset is None or self.current_transcript is None:
            return
        spec = ExportSpec(
            clip=self.clips[row],
            aspect_ratio=AspectRatio(self.aspect_combo.currentText()),
            encode_mode=EncodeMode(self.encode_combo.currentText()),
            burn_captions=self.burn_check.isChecked(),
            output_dir=str(Path.home() / ".cutline_studio" / "exports"),
        )
        worker = ExportWorker(self.pipeline, self.current_asset, self.current_transcript, spec)
        worker.progress.connect(lambda p, m: (self.progress_bar.setValue(p), self.status_label.setText(m)))
        worker.finished_ok.connect(
            lambda res: QMessageBox.information(self, "Export Complete", f"Saved:\n{res.video_path}")
        )
        worker.failed.connect(lambda err: QMessageBox.critical(self, "Export Error", err))
        self._worker = worker
        worker.start()

    def _queue_selected(self) -> None:
        row = self.clip_table.currentRow()
        if row < 0:
            return
        clip = self.clips[row]
        export_path = Path.home() / ".cutline_studio" / "exports" / f"{clip.id}_9x16.mp4"
        self.queue_store.enqueue(
            clip_id=clip.id,
            clip_title=clip.title,
            video_path=str(export_path),
            platform=PublishPlatform.YOUTUBE_SHORTS,
            caption_text=clip.caption_hook or clip.title,
            tags=clip.tags,
        )
        self._refresh_queue_table()

    def _refresh_queue_table(self) -> None:
        jobs = self.queue_store.list_jobs()
        self.queue_table.setRowCount(len(jobs))
        for row, job in enumerate(jobs):
            self.queue_table.setItem(row, 0, QTableWidgetItem(job.job_id))
            self.queue_table.setItem(row, 1, QTableWidgetItem(job.clip_title))
            self.queue_table.setItem(row, 2, QTableWidgetItem(job.platform.value))
            self.queue_table.setItem(row, 3, QTableWidgetItem(job.status.value))
            self.queue_table.setItem(row, 4, QTableWidgetItem(job.scheduled_at_iso or "Immediate"))

    def _process_queue(self) -> None:
        self.queue_store.process_due_jobs(self.publishers)
        self._refresh_queue_table()


def main() -> None:
    app = QApplication(sys.argv)
    win = CutlineMainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
