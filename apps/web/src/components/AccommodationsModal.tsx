import React, { useState, useEffect } from 'react';
import { api } from '../api';
import type { StudentAccommodation, RosterMember } from '../types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';

interface AccommodationsModalProps {
  courseId: number;
  isOpen: boolean;
  onClose: () => void;
}

export const AccommodationsModal: React.FC<AccommodationsModalProps> = ({
  courseId,
  isOpen,
  onClose,
}) => {
  const [accommodations, setAccommodations] = useState<StudentAccommodation[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState<number | ''>('');
  const [multiplier, setMultiplier] = useState<number>(1.5);
  const [extraMinutes, setExtraMinutes] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [accRes, rosterRes] = await Promise.all([
        api.get<{ accommodations: StudentAccommodation[] }>(`/accommodations/course/${courseId}`),
        api.get<{ roster: RosterMember[] }>(`/courses/${courseId}`),
      ]);
      setAccommodations(accRes.accommodations);
      setRoster(rosterRes.roster.filter((r) => r.role === 'student'));
    } catch (err: any) {
      const message = err.message || 'Failed to load accommodations.';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadData();
    }
  }, [isOpen, courseId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId) return;
    try {
      setSaving(true);
      setError(null);
      await api.post(`/accommodations/course/${courseId}`, {
        user_id: selectedUserId,
        time_multiplier: multiplier,
        extra_minutes: extraMinutes,
        notes,
      });
      toast.success('Accommodation saved.');
      setSelectedUserId('');
      setNotes('');
      setMultiplier(1.5);
      setExtraMinutes(0);
      await loadData();
    } catch (err: any) {
      const message = err.message || 'Failed to save accommodation.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (userId: number) => {
    if (!confirm('Remove this accommodation?')) return;
    try {
      await api.del(`/accommodations/course/${courseId}/user/${userId}`);
      toast.success('Accommodation removed.');
      await loadData();
    } catch (err: any) {
      const message = err.message || 'Failed to delete accommodation.';
      toast.error(message);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Student Accommodations & Accessibility</DialogTitle>
          <DialogDescription>
            Set individual time extensions for exams and checkpoints.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {error && (
            <div className="rounded-[var(--radius-md)] bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Add / Edit Form */}
          <form onSubmit={handleSave} className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Grant / Update Accommodation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="student-select">Select Student</Label>
                    <select
                      id="student-select"
                      value={selectedUserId}
                      onChange={(e) => setSelectedUserId(Number(e.target.value) || '')}
                      required
                      className="w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    >
                      <option value="">-- Choose student --</option>
                      {roster.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.email})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <Label htmlFor="multiplier-select">Time Multiplier</Label>
                    <select
                      id="multiplier-select"
                      value={multiplier}
                      onChange={(e) => setMultiplier(Number(e.target.value))}
                      className="w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    >
                      <option value={1.0}>1.0x (Standard)</option>
                      <option value={1.25}>1.25x (+25% time)</option>
                      <option value={1.5}>1.5x (Time & a half)</option>
                      <option value={2.0}>2.0x (Double time)</option>
                      <option value={3.0}>3.0x (Triple time)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-[1fr_2fr] gap-4">
                  <div>
                    <Label htmlFor="extra-minutes">Flat Extra Minutes</Label>
                    <Input
                      id="extra-minutes"
                      type="number"
                      min="0"
                      max="180"
                      value={extraMinutes}
                      onChange={(e) => setExtraMinutes(Number(e.target.value))}
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <Label htmlFor="notes">Reason / Documentation Notes</Label>
                    <Input
                      id="notes"
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="e.g. Accessibility services approved"
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button type="submit" disabled={saving || !selectedUserId}>
                    {saving ? 'Saving...' : 'Save Accommodation'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </form>

          {/* List of active accommodations */}
          <div>
            <h4 className="mb-3 text-base font-semibold">Active Course Accommodations</h4>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading accommodations...</p>
            ) : accommodations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No custom student accommodations configured for this course yet.
              </p>
            ) : (
              <div className="space-y-2">
                {accommodations.map((acc) => (
                  <div
                    key={acc.id}
                    className="flex items-center justify-between rounded-[var(--radius-md)] border p-4"
                  >
                    <div>
                      <div className="text-sm font-semibold">
                        {acc.user_name || `User #${acc.user_id}`}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {acc.user_email}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge variant="default">{acc.time_multiplier}x Time</Badge>
                        {acc.extra_minutes > 0 && <Badge variant="secondary">+{acc.extra_minutes} min</Badge>}
                        {acc.notes && (
                          <span className="text-xs text-muted-foreground">{acc.notes}</span>
                        )}
                      </div>
                    </div>
                    <Button variant="destructive" size="sm" onClick={() => void handleDelete(acc.user_id)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
