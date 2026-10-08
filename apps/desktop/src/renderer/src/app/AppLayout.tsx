import { Component, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from '../components/ui/icons';
import { MeetingPage } from '../meeting/MeetingPage';
import { useTheme } from '../theme/useTheme';
import './app.css';
import { AppHeader } from './AppHeader';
import { BannerSlot } from './BannerSlot';
import { HomePage } from './HomePage';
import { windowTitle } from './labels';
import { escapeLeavesPage, formatRoute, HOME, type Route } from './router';
import { SettingsPage } from './SettingsPage';
import { SetupRoute } from './SetupRoute';
import { useShell } from './ShellContext';

/**
 * The window: the slim header (on every page, Set up Roger included: D6), the banner slot above
 * every page, and the page the route names. The banner stays on every page, because capture
 * warnings must reach the user wherever they are.
 */
export function AppLayout() {
  // The one useTheme call (M4-S2): it puts the `theme` preference on <html> as data-theme. Without
  // it Light and Dark in the preferences do nothing and the page always follows macOS.
  const theme = useTheme();
  // A preference that could not be read is not shown: the page follows macOS meanwhile, so nothing
  // is lost and a banner above every page would be noise (docs/plans/redesign.md, Banners). It is
  // reported instead, not dropped. `reportError`, not `console`: the renderer has no logger.
  useEffect(() => {
    if (theme.error !== null) reportError(new Error(theme.error));
  }, [theme.error]);
  const { route, navigate } = useShell();
  const pageRef = useRef<HTMLElement>(null);
  useArrival(route, pageRef);
  useEscapeHome(route, () => {
    navigate(HOME);
  });
  return (
    // data-route: the meeting page's column is narrower than the others (app.css).
    <div className="shell" data-route={route.name}>
      <AppHeader />
      <div className="shell-main">
        <BannerSlot />
        {/*
          Keyed by route, so each page starts at its top rather than the last page's scroll, and
          with new state. MeetingPage keeps what must not cross meetings per meeting itself
          (regionsShownFor), so a scroll-to-top in place of this key cannot show meeting B's
          transcript with meeting A's state.
        */}
        <main key={formatRoute(route)} ref={pageRef} className="shell-page">
          {/* Inside the keyed <main>: a failed page resets when the person moves on. */}
          <PageBoundary>
            <Page route={route} />
          </PageBoundary>
        </main>
      </div>
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomePage />;
    case 'meeting':
      return <MeetingPage meetingId={route.meetingId} />;
    case 'settings':
      return <SettingsPage />;
    case 'setup':
      return <SetupRoute />;
  }
}

/**
 * On arrival at a page: focus its h1 (a screen reader says where it is; the header button that was
 * clicked may be gone) and name the window after it. The first render does neither: focus would be
 * taken from whatever the person had clicked on a reload.
 *
 * The h1 can come after the page does (a meeting's title is read first), so it waits for it with a
 * MutationObserver, and gives up on focus when the person has already moved into the page: stealing
 * focus from a field they started typing in is worse than a missed announcement. The window title
 * follows the h1 meanwhile. Electron sets the window's title from the page's `document.title`
 * (main has no `page-title-updated` handler: grep it before adding one).
 */
function useArrival(route: Route, pageRef: RefObject<HTMLElement | null>): void {
  const first = useRef(true);
  useEffect(() => {
    const page = pageRef.current;
    if (page === null) return;
    let focused = first.current;
    first.current = false;
    const sync = (): void => {
      const heading = page.querySelector('h1');
      document.title = windowTitle(route, heading?.textContent ?? '');
      if (focused || heading === null) return;
      focused = true;
      if (page.contains(document.activeElement)) return;
      // -1: focusable by script, not a tab stop; app.css draws no ring on it.
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    };
    sync();
    const watch = new MutationObserver(sync);
    watch.observe(page, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
    };
    // RouteStore.navigate drops a route to the page it is already on, so `route` changes only on arrival.
  }, [route, pageRef]);
}

/** A target Escape should leave alone: a field the person types in, or an open menu or dialog. */
export interface EscapeTarget {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  closest(selector: string): unknown;
}

export function escapeIsForThePage(target: EscapeTarget | null): boolean {
  if (target === null) return true;
  if (target.isContentEditable) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return false;
  return target.closest('[role="menu"], [role="dialog"], dialog') === null;
}

/**
 * Escape leaves Settings and Set up Roger for Home when focus is not in a text field (V3). Never
 * on the meeting page: it would leave the notes mid-sentence (escapeLeavesPage). A key something
 * else already handled (a menu closing) is not ours.
 */
function useEscapeHome(route: Route, goHome: () => void): void {
  useEffect(() => {
    if (!escapeLeavesPage(route)) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!escapeIsForThePage(target)) return;
      goHome();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [route, goHome]);
}

/**
 * One page failing to draw must not blank the window: only the page is replaced, so the header,
 * the recording chip and the banner (Stop) stay. The error goes to the log through `reportError`
 * (the renderer has no logger); the person gets one plain line and a way to try again.
 * "Reload" re-draws the page in place: reloading the window would restart the capture page.
 */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    reportError(error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <div role="alert" className="problem page-problem">
          <Icon name="circle-alert" />
          <span className="problem-text">Roger could not show this page.</span>
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={() => {
              this.setState({ failed: false });
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
