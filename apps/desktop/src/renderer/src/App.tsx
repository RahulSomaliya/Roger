// First, so the shell's own rules (app/app.css, imported by AppLayout) come after the base ones.
import './styles.css';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppLayout } from './app/AppLayout';
import { routeFromApp, RouteStore } from './app/router';
import { ShellProvider } from './app/ShellContext';

/**
 * The app shell: the route, the routes main sends, and the window's one capture view
 * (ShellContext) around the layout. The preview harness can render this same component over its
 * fake `window.roger`, so the styles are imported here rather than in main.tsx.
 */
export function App() {
  const [routes] = useState(() => new RouteStore(window));
  const route = useSyncExternalStore(routes.subscribe, routes.getSnapshot);

  useEffect(() => {
    // Listen first, then say ready: main sends a route it held as soon as it hears app:ready.
    const stopListening = window.roger.onNavigate((payload) => {
      const next = routeFromApp(payload);
      if (next !== null) routes.navigate(next);
    });
    window.roger.appReady();
    return stopListening;
  }, [routes]);

  return (
    <ShellProvider route={route} navigate={routes.navigate}>
      <AppLayout />
    </ShellProvider>
  );
}
