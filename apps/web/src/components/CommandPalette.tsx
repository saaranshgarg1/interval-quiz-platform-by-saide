import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, ListChecks, ShieldAlert, Moon, Sun, LogOut } from 'lucide-react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { useAuth } from '@/auth';
import { useTheme } from '@/lib/theme';

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const isStaff = user?.role !== 'student';

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search actions and pages…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => run(() => navigate('/'))}>
            <Home /> Home
          </CommandItem>
          <CommandItem onSelect={() => run(() => navigate('/results'))}>
            <ListChecks /> My results
          </CommandItem>
          {isStaff && (
            <CommandItem onSelect={() => run(() => navigate('/incidents'))}>
              <ShieldAlert /> Incidents
            </CommandItem>
          )}
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(toggle)}>
            {theme === 'dark' ? <Sun /> : <Moon />}
            Switch to {theme === 'dark' ? 'light' : 'dark'} theme
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                logout();
                navigate('/login');
              })
            }
          >
            <LogOut /> Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
