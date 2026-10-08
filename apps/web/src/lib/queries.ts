import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { api } from '../api';
import type {
  MyCoursesResponse,
  CourseQuizzesResponse,
  QuizDetailResponse,
  AttemptView,
  ResultRow,
  Incident,
  Audit,
  QuizAnalytics,
  Course,
  RosterMember,
  QuestionBank,
  BankQuestion,
} from '../types';

/**
 * Central react-query data layer. Every page reads server state through these
 * hooks and the `qk` key factory — no hand-rolled fetch/loading/error in pages.
 * Mutations live page-local; call `queryClient.invalidateQueries({ queryKey })`
 * with the matching `qk` entry after a write.
 */
export const qk = {
  courses: () => ['courses'] as const,
  course: (id: number) => ['courses', id] as const,
  courseQuizzes: (courseId: number) => ['quizzes', 'course', courseId] as const,
  quiz: (quizId: number) => ['quizzes', quizId] as const,
  attempt: (attemptId: number) => ['attempts', attemptId] as const,
  myAttempt: (versionId: number) => ['attempts', 'quiz', versionId, 'mine'] as const,
  incidents: (courseId: number) => ['attempts', 'course', courseId, 'incidents'] as const,
  resultsMine: () => ['results', 'mine'] as const,
  resultDetail: (attemptId: number) => ['results', 'attempt', attemptId] as const,
  audit: (attemptId: number) => ['review', 'attempt', attemptId] as const,
  analytics: (versionId: number) => ['analytics', 'version', versionId] as const,
  banks: (courseId: number) => ['banks', 'course', courseId] as const,
  bank: (bankId: number) => ['banks', bankId] as const,
} as const;

export interface CourseDetailResponse {
  course: Course;
  role: string;
  roster: RosterMember[];
}
export interface IncidentsResponse {
  incidents: Incident[];
}
export interface ResultsMineResponse {
  results: ResultRow[];
}
export interface BanksResponse {
  banks: QuestionBank[];
}
export interface BankDetailResponse {
  bank: QuestionBank;
  questions: BankQuestion[];
}

/** Options passthrough minus the parts each hook fixes (key + fetcher). */
type Extra<T> = Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, 'queryKey' | 'queryFn'>;

export function useCourses(opts?: Extra<MyCoursesResponse>) {
  return useQuery({ queryKey: qk.courses(), queryFn: () => api.get<MyCoursesResponse>('/courses'), ...opts });
}

export function useCourse(id: number, opts?: Extra<CourseDetailResponse>) {
  return useQuery({
    queryKey: qk.course(id),
    queryFn: () => api.get<CourseDetailResponse>(`/courses/${id}`),
    enabled: Number.isFinite(id),
    ...opts,
  });
}

export function useCourseQuizzes(courseId: number, opts?: Extra<CourseQuizzesResponse>) {
  return useQuery({
    queryKey: qk.courseQuizzes(courseId),
    queryFn: () => api.get<CourseQuizzesResponse>(`/quizzes/course/${courseId}`),
    enabled: Number.isFinite(courseId),
    ...opts,
  });
}

export function useQuiz(quizId: number, opts?: Extra<QuizDetailResponse>) {
  return useQuery({
    queryKey: qk.quiz(quizId),
    queryFn: () => api.get<QuizDetailResponse>(`/quizzes/${quizId}`),
    enabled: Number.isFinite(quizId),
    ...opts,
  });
}

export function useAttempt(attemptId: number, opts?: Extra<AttemptView>) {
  return useQuery({
    queryKey: qk.attempt(attemptId),
    queryFn: () => api.get<AttemptView>(`/attempts/${attemptId}`),
    enabled: Number.isFinite(attemptId),
    ...opts,
  });
}

export function useIncidents(courseId: number, opts?: Extra<IncidentsResponse>) {
  return useQuery({
    queryKey: qk.incidents(courseId),
    queryFn: () => api.get<IncidentsResponse>(`/attempts/course/${courseId}/incidents`),
    enabled: Number.isFinite(courseId),
    ...opts,
  });
}

export function useMyResults(opts?: Extra<ResultsMineResponse>) {
  return useQuery({
    queryKey: qk.resultsMine(),
    queryFn: () => api.get<ResultsMineResponse>('/results/mine'),
    ...opts,
  });
}

export function useAudit(attemptId: number, opts?: Extra<Audit>) {
  return useQuery({
    queryKey: qk.audit(attemptId),
    queryFn: () => api.get<Audit>(`/review/attempt/${attemptId}`),
    enabled: Number.isFinite(attemptId),
    ...opts,
  });
}

export function useAnalytics(versionId: number, opts?: Extra<QuizAnalytics>) {
  return useQuery({
    queryKey: qk.analytics(versionId),
    // The API wraps the payload as { analytics }.
    queryFn: async () => (await api.get<{ analytics: QuizAnalytics }>(`/analytics/version/${versionId}`)).analytics,
    enabled: Number.isFinite(versionId),
    ...opts,
  });
}

export function useBanks(courseId: number, opts?: Extra<BanksResponse>) {
  return useQuery({
    queryKey: qk.banks(courseId),
    queryFn: () => api.get<BanksResponse>(`/banks/course/${courseId}`),
    enabled: Number.isFinite(courseId),
    ...opts,
  });
}

export function useBank(bankId: number, opts?: Extra<BankDetailResponse>) {
  return useQuery({
    queryKey: qk.bank(bankId),
    queryFn: () => api.get<BankDetailResponse>(`/banks/${bankId}`),
    enabled: Number.isFinite(bankId),
    ...opts,
  });
}
