import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Unexpected application error',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-[#111724] border border-rose-500/40 rounded-lg p-6 space-y-4">
            <div className="flex items-center gap-2 text-rose-400 font-semibold text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>Workspace Error Caught</span>
            </div>
            <pre className="text-xs font-mono text-slate-300 bg-[#0B0F17] border border-slate-800 rounded p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {this.state.message}
            </pre>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Recover Workspace
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
