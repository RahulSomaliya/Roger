import { MeetingPage } from '../meeting/MeetingPage';
import { useTheme } from '../theme/useTheme';
import './app.css';
import { AppHeader } from './AppHeader';
import { BannerSlot } from './BannerSlot';
import { HomePage } from './HomePage';
import { formatRoute, type Route } from './router';
import { SettingsPage } from './SettingsPage';
import { SetupRoute } from './SetupRoute';
import { useShell } from './ShellContext';

/**
 * The window: the slim header, the banner slot above every page, and the page the route names.
 * The setup route fills the window without the header; the banner stays, because capture warnings
 * must reach the user wherever they are.
 */
export function AppLayout() {
  // The one useTheme call (M4-S2): it puts the `theme` preference on <html> as data-theme. Without
  // it Light and Dark in the preferences do nothing and the page always follows macOS.
  const theme = useTheme();
  const { route } = useShell();
  const fullWindow = route.name === 'setup';
  return (
    // data-route: the meeting page's column is wider than the others (app.css).
    <div className="shell" data-route={route.name}>
      {fullWindow ? null : <AppHeader />}
      <div className="shell-main">
        <BannerSlot themeError={theme.error} />
        {/*
          Keyed by route, so each page starts at its top rather than the last page's scroll, and
          with new state. MeetingPage keeps what must not cross meetings per meeting itself
          (regionsShownFor), so a scroll-to-top in place of this key cannot show meeting B's
          transcript with meeting A's state.
        */}
        <main key={formatRoute(route)} className="shell-page">
          <Page route={route} />
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
