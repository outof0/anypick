import { Component, type ReactNode } from 'react';
import { detectLanguage, translate } from './lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
}

/**
 * Catches the one throw the render path can raise: resolveBridge refuses to
 * run outside the Tauri shell, and that check happens during render. Without
 * a boundary the user saw a blank root instead of the message explaining why.
 * Anything else this catches is a bug that should be loud in development, so
 * the boundary logs to the console as well as rendering.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    console.error('[anypick] render failed:', error);
  }

  render() {
    if (this.state.message === null) {
      return this.props.children;
    }
    return (
      <div className="p-6">
        <p className="text-red">{translate('desktop.main.cannot_start', 'auto', detectLanguage())}</p>
        <p className="text-secondary mt-2">{this.state.message}</p>
      </div>
    );
  }
}
