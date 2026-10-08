import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, ListChecks, ShieldAlert, Moon, Sun, LogOut, BookOpen, FileText } from 'lucide-react';
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
import { useCourses } from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import type { CourseQuizzesResponse } from '@/types';

/** All quizzes across the user's courses, for palette search. */
function useSearchableQuizzes(enabled: boolean) {
  return useQuery({
    queryKey: ['palette-quizzes'],
    enabled,
    queryFn: async () => {
      const { courses } = await api.get<{ courses: { id: number }[] }>('/courses');
      const results: { quiz_id: number; title: string; courseId: number }[] = [];
      await Promise.all(
        courses.map(async (c) => {
          try {
            const r = await api.get<CourseQuizzesResponse>(`/quizzes/course/${c.id}`);
            for (const q of r.quizzes) {
              const title = q.published?.title ?? q.draft?.title;
              if (title) results.push({ quiz_id: q.quiz_id, title, courseId: c.id });
            }
          } catch {
            /* course may 403 — skip */
          }
        }),
      );
      return results;
    },
  });
}

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();
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

  // Courses always lightweight; quizzes only fetched once palette opens.
  const { data: coursesData } = useCourses({ enabled: open });
  const { data: quizzes } = useSearchableQuizzes(open);
  const courses = coursesData?.courses ?? [];

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
        {courses.length > 0 && (
          <CommandGroup heading="Courses">
            {courses.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.code} ${c.name}`}
                onSelect={() => run(() => navigate(`/courses/${c.id}`))}
              >
                <BookOpen /> {c.code} — {c.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {quizzes && quizzes.length > 0 && (
          <CommandGroup heading="Quizzes">
            {quizzes.map((q) => (
              <CommandItem
                key={q.quiz_id}
                value={q.title}
                onSelect={() => run(() => navigate(`/quizzes/${q.quiz_id}/preflight`))}
              >
                <FileText /> {q.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(toggle)}>
            {theme === 'dark' ? <Sun /> : <Moon />}
            Switch to {theme === 'dark' ? 'light' : 'dark'} theme
          </CommandItem>
          <CommandItem
            onSelect={() =>
              // Same confirmation as the top-bar button (owned by the layout).
              run(() => window.dispatchEvent(new Event('interval:request-sign-out')))
            }
          >
            <LogOut /> Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
