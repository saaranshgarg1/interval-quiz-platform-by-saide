import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, LogOut, Search, ShieldCheck, Users } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { Role } from '../types';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '../components/primitives';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { ConfirmAction } from '../components/ConfirmAction';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { toast } from '../components/ui/sonner';

interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  entry_number: string | null;
  created_at: string;
}

const ROLE_TEXT: Record<Role, string> = {
  student: 'Student',
  instructor: 'Instructor',
  admin: 'Admin',
};

const ROLE_EFFECT: Record<Role, string> = {
  student: 'They can take quizzes in courses they are enrolled in. Course staff roles (TA/instructor of a course) are set per course.',
  instructor: 'They can create courses and become the instructor of those courses.',
  admin: 'Full access to every course and to this page. Give this to very few people.',
};

/**
 * Platform administration. Accounts always register as students; this is where
 * an admin makes someone an instructor (or admin), fixes entry numbers and
 * revokes sessions.
 */
export function AdminPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const [pendingRole, setPendingRole] = useState<{ user: AdminUser; role: Role } | null>(null);
  const [entryEdits, setEntryEdits] = useState<Record<number, string>>({});

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/admin/users'),
  });

  const users = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.users ?? []).filter(
      (u) =>
        (roleFilter === 'all' || u.role === roleFilter) &&
        (!term ||
          u.name.toLowerCase().includes(term) ||
          u.email.toLowerCase().includes(term) ||
          (u.entry_number ?? '').toLowerCase().includes(term)),
    );
  }, [data, search, roleFilter]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });

  const changeRole = async (target: AdminUser, role: Role) => {
    try {
      await api.patch(`/admin/users/${target.id}/role`, { role });
      toast.success(`${target.name} is now ${ROLE_TEXT[role].toLowerCase()}. They need to sign in again.`);
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the role.');
    }
  };

  const saveEntry = async (target: AdminUser) => {
    try {
      await api.patch(`/admin/users/${target.id}/entry-number`, { entry_number: entryEdits[target.id] ?? '' });
      toast.success('Entry number saved.');
      setEntryEdits((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the entry number.');
    }
  };

  const revoke = async (target: AdminUser) => {
    try {
      await api.post(`/admin/users/${target.id}/revoke-sessions`);
      toast.success(`${target.name} was signed out on every device.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not sign them out.');
    }
  };

  const backup = async () => {
    try {
      const res = await api.post<{ file: string }>('/admin/backup');
      toast.success('Backup written.', { description: res.file });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Backup failed.');
    }
  };

  if (user?.role !== 'admin') {
    return (
      <Page title="Admin">
        <EmptyState icon={ShieldCheck} title="Admins only" description="Ask a platform admin if you need an account changed." />
      </Page>
    );
  }

  const counts = (data?.users ?? []).reduce<Record<string, number>>((acc, u) => ({ ...acc, [u.role]: (acc[u.role] ?? 0) + 1 }), {});

  return (
    <Page
      title="Users & roles"
      description="Everyone registers as a student. Make instructors here, fix entry numbers, and sign people out of every device."
      width="wide"
      actions={
        <ConfirmAction
          title="Back up the database now?"
          description="Takes an online copy into the server's backups folder. It is safe during a live exam; students are not interrupted."
          confirmLabel="Back up now"
          onConfirm={() => void backup()}
        >
          <Button variant="secondary" size="sm">
            <DatabaseBackup aria-hidden="true" /> Back up now
          </Button>
        </ConfirmAction>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input className="pl-8" placeholder="Search name, email or entry number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
        </div>
        {(['all', 'student', 'instructor', 'admin'] as const).map((r) => (
          <Button key={r} size="sm" variant={roleFilter === r ? 'default' : 'ghost'} onClick={() => setRoleFilter(r)}>
            {r === 'all' ? `All (${data?.users.length ?? 0})` : `${ROLE_TEXT[r]}s (${counts[r] ?? 0})`}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={6} variant="list" />
      ) : isError ? (
        <ErrorState title="Could not load users" error={error} onRetry={() => void refetch()} />
      ) : users.length === 0 ? (
        <EmptyState icon={Users} title="No users match" description="Change the search or filter." />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-lg)] border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Entry number</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Joined</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === user.id;
                const entryDraft = entryEdits[u.id];
                return (
                  <tr key={u.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">
                        {u.name} {isSelf && <Badge variant="outline">you</Badge>}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-8 w-40 font-mono"
                          value={entryDraft ?? u.entry_number ?? ''}
                          placeholder="—"
                          aria-label={`Entry number for ${u.name}`}
                          onChange={(e) => setEntryEdits((prev) => ({ ...prev, [u.id]: e.target.value }))}
                        />
                        {entryDraft !== undefined && entryDraft !== (u.entry_number ?? '') && (
                          <Button size="sm" variant="secondary" onClick={() => void saveEntry(u)}>
                            Save
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Role for ${u.name}`}
                        value={u.role}
                        disabled={isSelf}
                        title={isSelf ? 'You cannot change your own role' : undefined}
                        onChange={(e) => setPendingRole({ user: u, role: e.target.value as Role })}
                        className="w-36 rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-2 py-1.5 text-sm disabled:opacity-60"
                      >
                        <option value="student">Student</option>
                        <option value="instructor">Instructor</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(`${u.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ConfirmAction
                        title={`Sign ${u.name} out everywhere?`}
                        description="Every device they are signed in on must sign in again. Use it after a shared or lost device. An attempt in progress keeps its saved answers."
                        confirmLabel="Sign out everywhere"
                        destructive
                        onConfirm={() => void revoke(u)}
                      >
                        <Button size="sm" variant="ghost" disabled={isSelf}>
                          <LogOut aria-hidden="true" /> Sign out everywhere
                        </Button>
                      </ConfirmAction>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={pendingRole !== null} onOpenChange={(o) => !o && setPendingRole(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Make {pendingRole?.user.name} {pendingRole ? (pendingRole.role === 'admin' ? 'an admin' : `a ${pendingRole.role}`) : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRole && ROLE_EFFECT[pendingRole.role]} They are signed out so the change takes effect immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRole) void changeRole(pendingRole.user, pendingRole.role);
                setPendingRole(null);
              }}
            >
              Change role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
