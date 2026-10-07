import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, FileText, AlertCircle, Plus } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { CourseQuizzesResponse, QuizList } from '../types';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface CourseBlock {
  id: number;
  code: string;
  name: string;
  my_role?: string;
  quizzes: QuizList[];
  loadError: string | null;
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<CourseBlock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewCourse, setShowNewCourse] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get<{ courses: { id: number; code: string; name: string; my_role?: string }[] }>('/courses');
      const blocks: CourseBlock[] = await Promise.all(
        res.courses.map(async (c) => {
          try {
            const qz = await api.get<CourseQuizzesResponse>(`/quizzes/course/${c.id}`);
            return { id: c.id, code: c.code, name: c.name, my_role: c.my_role, quizzes: qz.quizzes, loadError: null };
          } catch (err) {
            return {
              id: c.id,
              code: c.code,
              name: c.name,
              my_role: c.my_role,
              quizzes: [],
              loadError: err instanceof ApiError ? err.message : 'Failed to load quizzes.',
            };
          }
        }),
      );
      setCourses(blocks);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load courses.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const published = (c: CourseBlock) => c.quizzes.filter((q) => q.published);
  const drafts = (c: CourseBlock) => c.quizzes.filter((q) => q.draft && !q.published);

  const isStaff = user?.role === 'instructor' || user?.role === 'admin';

  const handleScrollToCourses = () => {
    const coursesSection = document.getElementById('courses-section');
    if (coursesSection) {
      coursesSection.scrollIntoView({ behavior: 'smooth' });
    } else if (courses.length > 0) {
      navigate(`/courses/${courses[0].id}`);
    }
  };

  return (
    <Page
      title={`Hello, ${user?.name.split(' ')[0]}.`}
      description={
        user?.role === 'student'
          ? 'Your courses and available quizzes. Saved answers survive interruptions — watch the save indicator.'
          : 'Your courses. You can author, publish, review incidents and release results here.'
      }
      width="wide"
    >
      {error && <ErrorState error={error} onRetry={load} />}

      {!error && (
        <>
          <section className="mb-8">
            <h2 className="font-display text-lg font-semibold tracking-tight text-foreground mb-4">Quick actions</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card className="h-full flex flex-col">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BookOpen className="size-5" />
                    Complete a quiz
                  </CardTitle>
                  <CardDescription>
                    Pick a course below and enter a published quiz. Review the rules on the preflight screen, then start.
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto">
                  <Button variant="secondary" size="sm" onClick={handleScrollToCourses}>
                    Go to courses
                  </Button>
                </CardContent>
              </Card>

              {isStaff && (
                <Card className="h-full flex flex-col">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <AlertCircle className="size-5" />
                      Review incidents
                    </CardTitle>
                    <CardDescription>
                      Locked or expired attempts appear under Incidents for authorized review.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto">
                    <Button variant="secondary" size="sm" onClick={() => navigate('/incidents')}>
                      Open incidents
                    </Button>
                  </CardContent>
                </Card>
              )}

              <Card className="h-full flex flex-col">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="size-5" />
                    My results
                  </CardTitle>
                  <CardDescription>
                    View your quiz attempts, scores, and detailed feedback on past submissions.
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto">
                  <Button variant="secondary" size="sm" onClick={() => navigate('/results')}>
                    View results
                  </Button>
                </CardContent>
              </Card>

              {isStaff && (
                <Card className="h-full flex flex-col">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Plus className="size-5" />
                      New course
                    </CardTitle>
                    <CardDescription>
                      Create a new course and enroll students to get started with quizzes.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto">
                    <Button variant="secondary" size="sm" onClick={() => setShowNewCourse(true)}>
                      Create course
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          </section>

          <section id="courses-section">
            <h2 className="font-display text-lg font-semibold tracking-tight text-foreground mb-4">Your courses</h2>
            {loading ? (
              <LoadingSkeleton variant="cards" rows={3} />
            ) : courses.length === 0 ? (
              <EmptyState
                title="No courses yet"
                description="Contact an instructor to be enrolled in a course."
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {courses.map((c) => (
                  <Card key={c.id} className="h-full flex flex-col">
                    <CardHeader>
                      <CardTitle className="text-primary">{c.code}</CardTitle>
                      <CardDescription className="flex items-center gap-2">
                        {c.name}
                        <Badge variant="outline" className="ml-auto">
                          {c.my_role}
                        </Badge>
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3 flex-1">
                      {c.loadError ? (
                        <div className="text-sm text-destructive bg-destructive/10 rounded-md p-2">
                          Couldn't load quizzes: {c.loadError}
                        </div>
                      ) : published(c).length === 0 && drafts(c).length === 0 ? (
                        <p className="text-sm text-muted-foreground">No quizzes yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {published(c).map((q) => {
                            const st = q.published?.my_attempts;
                            return (
                              <div key={q.quiz_id} className="flex items-center gap-2 flex-wrap text-sm">
                                <Link
                                  to={`/quizzes/${q.quiz_id}/preflight`}
                                  className="text-foreground hover:underline"
                                >
                                  {q.published?.title}
                                </Link>
                                {st?.in_progress ? (
                                  <Badge variant="default">Continue attempt</Badge>
                                ) : st && (st.count ?? 0) > 0 ? (
                                  <Badge variant="secondary">{st.count} attempt(s)</Badge>
                                ) : (
                                  <Badge variant="outline">v{q.published?.version}</Badge>
                                )}
                                <span className="text-xs text-muted-foreground">
                                  {st?.count ?? 0}/{q.published?.attempts_allowed ?? 1}
                                </span>
                              </div>
                            );
                          })}
                          {drafts(c).map((q) => (
                            <div key={q.quiz_id} className="flex items-center gap-2 flex-wrap text-sm">
                              <span className="text-muted-foreground">{q.draft?.title}</span>
                              <Badge variant="warning">Draft</Badge>
                              <Link
                                to={`/quizzes/${q.quiz_id}`}
                                className="text-xs text-primary hover:underline"
                              >
                                Edit draft
                              </Link>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mt-auto pt-3">
                        <Button asChild variant="secondary" size="sm" className="w-full">
                          <Link to={`/courses/${c.id}`}>Open course</Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {isStaff && (
        <NewCourseDialog
          open={showNewCourse}
          onOpenChange={setShowNewCourse}
          onSuccess={load}
        />
      )}
    </Page>
  );
}

function NewCourseDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [emails, setEmails] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) {
      toast.error('Course code and name are required.');
      return;
    }

    setSubmitting(true);
    try {
      const { course } = await api.post<{ course: { id: number; code: string; name: string } }>('/courses', {
        code: code.trim(),
        name: name.trim(),
      });

      toast.success('Course created', { description: `${course.code} - ${course.name}` });

      if (emails.trim()) {
        try {
          const res = await api.post<{ enrolled: any[]; not_found: string[] }>(
            `/courses/${course.id}/members/bulk`,
            { emails: emails.trim() }
          );

          if (res.enrolled.length > 0) {
            toast.success(`Enrolled ${res.enrolled.length} student(s)`);
          }

          if (res.not_found.length > 0) {
            toast.error('Some emails not found', {
              description: `Not found: ${res.not_found.join(', ')}`,
            });
          }
        } catch (err) {
          toast.error('Enrollment failed', {
            description: err instanceof ApiError ? err.message : 'Could not enroll students.',
          });
        }
      }

      setCode('');
      setName('');
      setEmails('');
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error('Failed to create course', {
        description: err instanceof ApiError ? err.message : 'An error occurred.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Course</DialogTitle>
          <DialogDescription>
            Create a course and optionally enroll students by providing their email addresses.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="course-code">Course Code</Label>
            <Input
              id="course-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. CS101"
              required
            />
          </div>
          <div>
            <Label htmlFor="course-name">Course Name</Label>
            <Input
              id="course-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Introduction to Programming"
              required
            />
          </div>
          <div>
            <Label htmlFor="student-emails">Student Emails (optional)</Label>
            <Textarea
              id="student-emails"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="student1@example.com, student2@example.com&#10;or one per line"
              rows={4}
            />
            <p className="text-xs text-muted-foreground mt-1">
              One per line or comma-separated. Students must have existing accounts.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Course'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
