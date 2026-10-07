import { useState, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  BookOpen,
  Clock,
  Copy,
  Edit,
  Eye,
  History,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { RosterMember, QuizList, VersionDetail } from '../types';
import { useCourse, useCourseQuizzes, qk } from '../lib/queries';
import { toast } from '../components/ui/sonner';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '../components/primitives';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { AccommodationsModal } from '../components/AccommodationsModal';

/**
 * CoursePage — course home: header + role badge, quiz list (cards), and roster
 * (staff/admin only). Students see only the quiz list.
 *
 * Route contract (unchanged): /courses/:courseId
 *
 * Data layer: `useCourse` + `useCourseQuizzes` (react-query). Mutations
 * (create quiz, add/remove member, release results) invalidate the matching
 * query keys via the shared queryClient.
 */

const MEMBER_ROLE_OPTIONS = [
  { value: 'student', label: 'Student' },
  { value: 'ta', label: 'TA' },
  { value: 'instructor', label: 'Instructor' },
] as const;

const addMemberSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  memberRole: z.enum(['student', 'ta', 'instructor']),
});
type AddMemberForm = z.infer<typeof addMemberSchema>;

const bulkEnrollSchema = z.object({
  emails: z.string().min(1, 'Enter at least one email address.'),
  memberRole: z.enum(['student', 'ta', 'instructor']),
});
type BulkEnrollForm = z.infer<typeof bulkEnrollSchema>;

/** Map a role string to a badge variant + icon. Colour is a secondary cue. */
function roleBadge(role: string): { variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'; icon: React.ReactNode; label: string } {
  switch (role) {
    case 'instructor':
      return { variant: 'default', icon: <Users className="size-3" aria-hidden="true" />, label: 'Instructor' };
    case 'ta':
      return { variant: 'secondary', icon: <Users className="size-3" aria-hidden="true" />, label: 'TA' };
    case 'admin':
      return { variant: 'success', icon: <Users className="size-3" aria-hidden="true" />, label: 'Admin' };
    default:
      return { variant: 'outline', icon: <Users className="size-3" aria-hidden="true" />, label: role };
  }
}

/** Status → badge variant + icon for quiz version state. */
function versionBadge(v: { status: string } | null): { variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'; icon: React.ReactNode; label: string } | null {
  if (!v) return null;
  switch (v.status) {
    case 'published':
      return { variant: 'success', icon: <Clock className="size-3" aria-hidden="true" />, label: 'Published' };
    case 'draft':
      return { variant: 'warning', icon: <Edit className="size-3" aria-hidden="true" />, label: 'Draft' };
    case 'archived':
      return { variant: 'secondary', icon: <Clock className="size-3" aria-hidden="true" />, label: 'Archived' };
    default:
      return { variant: 'outline', icon: <Clock className="size-3" aria-hidden="true" />, label: v.status };
  }
}

export function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();

  const cid = courseId ? Number(courseId) : NaN;
  const { data: courseData, error: courseError, isError: courseIsError, refetch: refetchCourse } = useCourse(cid);
  const { data: quizzesData, error: quizzesError, isError: quizzesIsError, refetch: refetchQuizzes } = useCourseQuizzes(cid);

  const [showAccommodations, setShowAccommodations] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RosterMember | null>(null);

  const isStaff = !!user && user.role !== 'student';

  const error = courseError ?? quizzesError;
  const isError = courseIsError || quizzesIsError;

  const handleRetry = () => {
    void refetchCourse();
    void refetchQuizzes();
  };

  const handleCreateQuiz = async () => {
    try {
      const res = await api.post<{ quiz_id: number }>(`/quizzes/course/${cid}`);
      navigate(`/quizzes/${res.quiz_id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Creation failed.');
    }
  };

  const handleRelease = async (versionId: number) => {
    try {
      const r = await api.post<{ released: number }>(`/results/quiz/${versionId}/release`);
      toast.success(`Released ${r.released} result(s).`);
      void qc.invalidateQueries({ queryKey: qk.courseQuizzes(cid) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Release failed.');
    }
  };

  const handleAddMember = async (data: AddMemberForm) => {
    try {
      await api.put(`/courses/${cid}/members`, { email: data.email, memberRole: data.memberRole });
      toast.success(`Added ${data.email} as ${data.memberRole}.`);
      void qc.invalidateQueries({ queryKey: qk.course(cid) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Adding member failed.');
    }
  };

  const handleRemoveMember = async () => {
    if (!removeTarget) return;
    try {
      await api.del(`/courses/${cid}/members/${removeTarget.id}`);
      toast.success(`Removed ${removeTarget.email}.`);
      void qc.invalidateQueries({ queryKey: qk.course(cid) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove member.');
    } finally {
      setRemoveTarget(null);
    }
  };

  const handleCopyQuiz = async (quizId: number) => {
    try {
      await api.post<{ quiz_id: number }>(`/quizzes/${quizId}/copy`, {});
      toast.success('Quiz duplicated.');
      void qc.invalidateQueries({ queryKey: qk.courseQuizzes(cid) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Copy failed.');
    }
  };

  const handleDeleteQuiz = async (quizId: number) => {
    try {
      await api.del(`/quizzes/${quizId}`);
      toast.success('Quiz deleted.');
      void qc.invalidateQueries({ queryKey: qk.courseQuizzes(cid) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
    }
  };

  const handleBulkEnroll = async (data: BulkEnrollForm) => {
    try {
      const emails = data.emails
        .split(/[\n,]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      const result = await api.post<{ enrolled: any[]; not_found: string[] }>(
        `/courses/${cid}/members/bulk`,
        { emails, memberRole: data.memberRole },
      );
      toast.success(`Enrolled ${result.enrolled.length} member(s).`);
      if (result.not_found.length > 0) {
        toast.error(`Not found: ${result.not_found.join(', ')}`);
      }
      void qc.invalidateQueries({ queryKey: qk.course(cid) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Bulk enroll failed.');
    }
  };

  if (!cid || Number.isNaN(cid)) {
    return (
      <Page title="Course" description="Invalid course id." width="wide">
        <ErrorState error="Invalid course id." onRetry={() => navigate('/')} />
      </Page>
    );
  }

  if (isError) {
    return (
      <Page title="Course" description="Could not load this course." width="wide">
        <ErrorState error={error} onRetry={handleRetry} />
      </Page>
    );
  }

  if (!courseData || !quizzesData) {
    return (
      <Page
        title="Loading course…"
        description="Fetching course details and quizzes."
        width="wide"
      >
        <LoadingSkeleton variant="cards" rows={3} />
      </Page>
    );
  }

  const { course, role, roster } = courseData;
  const quizzes: QuizList[] = quizzesData.quizzes;

  const roleInfo = roleBadge(role);
  const actions = isStaff ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="secondary" size="sm">
        <Link to={`/courses/${cid}/banks`}>
          <BookOpen className="size-4" aria-hidden="true" />
          Question Banks
        </Link>
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setShowAccommodations(true)}>
        <Clock className="size-4" aria-hidden="true" />
        Accommodations
      </Button>
      <Button variant="default" size="sm" onClick={() => void handleCreateQuiz()}>
        <Plus className="size-4" aria-hidden="true" />
        New quiz
      </Button>
    </div>
  ) : null;

  return (
    <Page
      title={`${course.code} · ${course.name}`}
      description={
        <span className="inline-flex items-center gap-1.5">
          Your role:
          <Badge variant={roleInfo.variant} className="inline-flex items-center gap-1">
            {roleInfo.icon}
            {roleInfo.label}
          </Badge>
        </span>
      }
      actions={actions}
      width="wide"
    >
      {/* Quizzes */}
      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold tracking-tight text-foreground mb-3">Quizzes</h2>
        {quizzes.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No quizzes yet"
            description={isStaff ? 'Create a quiz to get started.' : 'No quizzes have been published for this course.'}
            action={isStaff ? (
              <Button variant="default" size="sm" onClick={() => void handleCreateQuiz()}>
                <Plus className="size-4" aria-hidden="true" />
                New quiz
              </Button>
            ) : undefined}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quizzes.map((q) => (
              <QuizCard
                key={q.quiz_id}
                quiz={q}
                role={role}
                isStaff={isStaff}
                onRelease={handleRelease}
                onCopy={handleCopyQuiz}
                onDelete={handleDeleteQuiz}
                onInvalidate={() => qc.invalidateQueries({ queryKey: qk.courseQuizzes(cid) })}
              />
            ))}
          </div>
        )}
      </section>

      {/* Roster — staff/admin only */}
      {isStaff && (
        <section className="mt-8">
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground mb-3">Roster</h2>
          <RosterTable
            roster={roster ?? []}
            onRemove={(m) => setRemoveTarget(m)}
          />
          <AddMemberForm courseId={cid} onSubmit={handleAddMember} />
          <BulkEnrollForm courseId={cid} onSubmit={handleBulkEnroll} />
        </section>
      )}

      {/* Accommodations modal (shared component, rendered as-is) */}
      {showAccommodations && (
        <AccommodationsModal
          courseId={cid}
          isOpen={showAccommodations}
          onClose={() => setShowAccommodations(false)}
        />
      )}

      {/* Remove member confirmation */}
      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogTrigger asChild>
          <span className="hidden" />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.email} will lose access to this course. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:brightness-105"
              onClick={() => void handleRemoveMember()}
            >
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/**
 * Quiz card — shows published/draft status badges and role-appropriate links:
 * editor, preflight, analytics, release results.
 */
function QuizCard({
  quiz,
  role,
  isStaff,
  onRelease,
  onCopy,
  onDelete,
  onInvalidate,
}: {
  quiz: QuizList;
  role: string;
  isStaff: boolean;
  onRelease: (versionId: number) => void;
  onCopy: (quizId: number) => void;
  onDelete: (quizId: number) => void;
  onInvalidate: () => void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<VersionDetail[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  const pub = quiz.published;
  const draft = quiz.draft;
  const title = pub?.title ?? draft?.title ?? 'Untitled quiz';
  const pubBadge = versionBadge(pub);
  const draftBadge = versionBadge(draft);

  const attempt = pub?.my_attempts;
  const hasAttempts = pub?.attempts && pub.attempts.total > 0;

  const handleOpenVersions = async () => {
    setVersionsOpen(true);
    setLoadingVersions(true);
    try {
      const d = await api.get<{ versions: VersionDetail[] }>(`/quizzes/${quiz.quiz_id}`);
      setVersions(d.versions);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load versions.');
    } finally {
      setLoadingVersions(false);
    }
  };

  const handleRestore = async (version: number) => {
    try {
      await api.post(`/quizzes/${quiz.quiz_id}/versions/${version}/restore`, {});
      toast.success(`Restored v${version} into a new draft.`);
      onInvalidate();
      setVersionsOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Restore failed.');
    }
  };

  const currentVersion = pub ?? draft;
  const isScheduled = currentVersion?.quiz_type === 'scheduled';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          {pubBadge && (
            <Badge variant={pubBadge.variant} className="inline-flex items-center gap-1">
              {pubBadge.icon}
              {pubBadge.label} v{pub!.version}
            </Badge>
          )}
          {draftBadge && !pub && (
            <Badge variant={draftBadge.variant} className="inline-flex items-center gap-1">
              {draftBadge.icon}
              {draftBadge.label}
            </Badge>
          )}
          {isScheduled && currentVersion?.window_opens_at && (
            <Badge variant="outline" className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden="true" />
              Scheduled: opens {new Date(currentVersion.window_opens_at).toLocaleString()}
              {currentVersion.window_duration_minutes && ` · ${currentVersion.window_duration_minutes} min`}
            </Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {pub
            ? `${pub.questions.length} questions · ${pub.duration_minutes ? `${pub.duration_minutes} min` : 'no timer'} · policy ${pub.integrity_policy} · ${pub.show_scores} scores`
            : `${draft?.questions.length ?? 0} questions in draft`}
        </p>
        {pub?.published_at && (
          <p className="text-xs text-muted-foreground">
            Published {new Date(pub.published_at).toLocaleString()}
          </p>
        )}
        {hasAttempts && (
          <p className="text-xs text-muted-foreground">
            {pub!.attempts!.total} attempt(s):{' '}
            {Object.entries(pub!.attempts!.statuses)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}{' '}
            · avg {(pub!.attempts!.avg_score ?? 0).toFixed(1)}
          </p>
        )}
        {attempt && attempt.count > 0 && (
          <p className="text-xs text-muted-foreground">
            Your attempts: {attempt.count} · best {attempt.best_score ?? '—'}
            {attempt.last_status === 'submitted' && attempt.last_receipt
              ? ` · receipt ${attempt.last_receipt}`
              : ''}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-2">
          {pub && (
            <Button asChild variant="secondary" size="sm">
              <Link to={`/quizzes/${quiz.quiz_id}/preflight`}>
                {attempt?.in_progress ? 'Continue attempt' : role === 'student' ? 'Take quiz' : 'View published'}
              </Link>
            </Button>
          )}
          {isStaff && draft && (
            <Button asChild variant="secondary" size="sm">
              <Link to={`/quizzes/${quiz.quiz_id}`}>
                <Edit className="size-3" aria-hidden="true" />
                Edit draft
              </Link>
            </Button>
          )}
          {isStaff && pub && (
            <>
              <Button asChild variant="secondary" size="sm">
                <Link to={`/analytics/version/${pub.id}`}>
                  <LayoutDashboard className="size-3" aria-hidden="true" />
                  Analytics
                </Link>
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void onRelease(pub.id)}>
                <RefreshCw className="size-3" aria-hidden="true" />
                Release results
              </Button>
              <Button asChild variant="secondary" size="sm">
                <Link to={`/quizzes/${quiz.quiz_id}`}>
                  <Eye className="size-3" aria-hidden="true" />
                  View
                </Link>
              </Button>
            </>
          )}
          {isStaff && (
            <>
              <Button variant="secondary" size="sm" onClick={handleOpenVersions}>
                <History className="size-3" aria-hidden="true" />
                Versions
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onCopy(quiz.quiz_id)}>
                <Copy className="size-3" aria-hidden="true" />
                Copy
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(quiz.quiz_id)}>
                <Trash2 className="size-3" aria-hidden="true" />
                Delete
              </Button>
            </>
          )}
        </div>
      </CardContent>

      {/* Versions dialog */}
      <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Version History</DialogTitle>
            <DialogDescription>
              Restore a prior version to create a new draft based on it.
            </DialogDescription>
          </DialogHeader>
          {loadingVersions ? (
            <p className="text-sm text-muted-foreground">Loading versions...</p>
          ) : versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions available.</p>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border p-3"
                >
                  <div className="text-sm">
                    <span className="font-medium">v{v.version}</span> · {v.status} · {v.questions.length} Qs
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void handleRestore(v.version)}>
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setVersionsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget === quiz.quiz_id} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this quiz and all its versions. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:brightness-105"
              onClick={() => {
                if (deleteTarget) onDelete(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Delete quiz
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * Roster table — @tanstack/react-table with columns name, email, role badge,
 * and (instructor only) a remove action confirmed via AlertDialog.
 */
function RosterTable({
  roster,
  onRemove,
}: {
  roster: RosterMember[];
  onRemove: (member: RosterMember) => void;
}) {
  const columns = useMemo<ColumnDef<RosterMember>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
      },
      {
        accessorKey: 'email',
        header: 'Email',
        cell: ({ getValue }) => (
          <span className="text-muted-foreground font-mono">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: 'role',
        header: 'Role',
        cell: ({ getValue }) => {
          const r = getValue<string>();
          const info = roleBadge(r);
          return (
            <Badge variant={info.variant} className="inline-flex items-center gap-1">
              {info.icon}
              {info.label}
            </Badge>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onRemove(row.original)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            <span className="sr-only">Remove {row.original.name}</span>
          </Button>
        ),
      },
    ],
    [onRemove],
  );

  const table = useReactTable({
    data: roster,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (roster.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No members yet"
        description="Add members to give them access to this course."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)] border">
      <table className="w-full border-collapse text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground"
                >
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-b transition-colors">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-muted-foreground">
                No members.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Add member form — react-hook-form + zod. PUTs to /courses/:courseId/members.
 */
function AddMemberForm({
  courseId,
  onSubmit,
}: {
  courseId: number;
  onSubmit: (data: AddMemberForm) => Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddMemberForm>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { email: '', memberRole: 'student' },
  });

  const handleValid = async (data: AddMemberForm) => {
    await onSubmit(data);
    reset({ email: '', memberRole: 'student' });
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Add member</CardTitle>
        <CardDescription>
          Uses the email of an existing account. The member must already have an
          Interval account registered with this email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(handleValid)} noValidate className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <Label htmlFor={`member-email-${courseId}`}>Email</Label>
            <Input
              id={`member-email-${courseId}`}
              type="email"
              placeholder="student@iitrpr.ac.in"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? `member-email-${courseId}-error` : undefined}
              {...register('email')}
            />
            {errors.email && (
              <p id={`member-email-${courseId}-error`} role="alert" className="mt-1 text-xs text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>
          <div className="min-w-[140px]">
            <Label htmlFor={`member-role-${courseId}`}>Role</Label>
            <select
              id={`member-role-${courseId}`}
              className="w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              {...register('memberRole')}
            >
              {MEMBER_ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
                Adding…
              </>
            ) : (
              'Add'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Bulk enroll form — allows staff to add multiple members at once.
 */
function BulkEnrollForm({
  courseId,
  onSubmit,
}: {
  courseId: number;
  onSubmit: (data: BulkEnrollForm) => Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<BulkEnrollForm>({
    resolver: zodResolver(bulkEnrollSchema),
    defaultValues: { emails: '', memberRole: 'student' },
  });

  const handleValid = async (data: BulkEnrollForm) => {
    await onSubmit(data);
    reset({ emails: '', memberRole: 'student' });
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Bulk enroll</CardTitle>
        <CardDescription>
          Add multiple members at once. Separate emails with newlines or commas.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(handleValid)} noValidate className="space-y-3">
          <div>
            <Label htmlFor={`bulk-emails-${courseId}`}>Emails</Label>
            <Textarea
              id={`bulk-emails-${courseId}`}
              placeholder="student1@iitrpr.ac.in, student2@iitrpr.ac.in"
              rows={4}
              aria-invalid={!!errors.emails}
              aria-describedby={errors.emails ? `bulk-emails-${courseId}-error` : undefined}
              {...register('emails')}
            />
            {errors.emails && (
              <p id={`bulk-emails-${courseId}-error`} role="alert" className="mt-1 text-xs text-destructive">
                {errors.emails.message}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor={`bulk-role-${courseId}`}>Role</Label>
            <select
              id={`bulk-role-${courseId}`}
              className="w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              {...register('memberRole')}
            >
              {MEMBER_ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
                Enrolling…
              </>
            ) : (
              'Enroll members'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
