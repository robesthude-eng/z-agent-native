import { AlertTriangle } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { captureException } from "@/lib/sentry";

interface Props {
  children: ReactNode;
  /**
   * Локальный экран ошибки вместо полностраничной карточки. Нужен для
   * ленивых панелей: у них падает один чанк, а не всё приложение, и
   * «Reset UI to Git» там был бы несоразмерным предложением.
   */
  fallback?: ReactNode;
}
interface State {
  hasError: boolean;
  message: string;
}

/**
 * Catches render-time errors so a crash in one component (e.g. Workspace
 * receiving unexpected data) shows a friendly message instead of a blank
 * white screen. The user can click "Reload" to reset.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message:
        typeof error.message === "string"
          ? error.message
          : JSON.stringify(error.message),
    };
  }

  componentDidCatch(error: Error) {
    captureException(error);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex min-h-dvh items-center justify-center bg-background p-6">
          <Card className="w-full max-w-md text-center shadow-lg">
            <CardContent className="space-y-4 pt-8 pb-8">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <h2 className="text-xl font-semibold">Something went wrong</h2>
              <p className="text-sm text-muted-foreground">
                {this.state.message}
              </p>
              <p className="text-xs text-muted-foreground">
                Перезагрузите приложение. Данные чата и workspace хранятся в runtime и не потеряются.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                <Button type="button" onClick={this.handleReload}>
                  Перезагрузить
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
