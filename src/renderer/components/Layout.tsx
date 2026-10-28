import { useEffect, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import TitleBar from './TitleBar';
import Sidebar from './Sidebar';
import { NewProjectProvider } from './NewProjectModal';
import { useData } from '../state/DataProvider';
import { cn } from './ui';

/** ApplicationShell: title bar, sidebar and the scrolling content region. */
export default function Layout() {
  const { settings } = useData();

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(settings.reduceMotion);
  }, [settings.reduceMotion]);

  return (
    <NewProjectProvider>
      <div className="flex h-screen w-screen flex-col bg-canvas">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="relative min-w-0 flex-1 overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
    </NewProjectProvider>
  );
}

/** Standard scrolling page with consistent gutters and max width. */
export function Page({ children, width = 'default', className }: { children: ReactNode; width?: 'default' | 'narrow' | 'wide'; className?: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          'mx-auto w-full px-8 pt-10 pb-16 xl:px-12 xl:pt-12',
          width === 'default' && 'max-w-[1280px]',
          width === 'narrow' && 'max-w-[880px]',
          width === 'wide' && 'max-w-[1600px]',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
