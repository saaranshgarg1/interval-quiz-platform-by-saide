import React, { useState, useEffect } from 'react';
import { api } from '../api';
import type { StudentAccommodation, RosterMember } from '../types';
import { Button, Card, Badge } from './ui';

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
      const [accRes, rosterRes] = await Promise.all([
        api.get<{ accommodations: StudentAccommodation[] }>(`/accommodations/course/${courseId}`),
        api.get<{ roster: RosterMember[] }>(`/courses/${courseId}`),
      ]);
      setAccommodations(accRes.accommodations);
      setRoster(rosterRes.roster.filter((r) => r.role === 'student'));
    } catch (err: any) {
      setError(err.message || 'Failed to load accommodations.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, courseId]);

  if (!isOpen) return null;

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
      setSelectedUserId('');
      setNotes('');
      setMultiplier(1.5);
      setExtraMinutes(0);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to save accommodation.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (userId: number) => {
    if (!confirm('Remove this accommodation?')) return;
    try {
      await api.del(`/accommodations/course/${courseId}/user/${userId}`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to delete accommodation.');
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '20px',
      }}
    >
      <div
        style={{
          background: 'var(--bg, #ffffff)',
          borderRadius: '12px',
          maxWidth: '700px',
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
        }}
      >
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border, #e2e8f0)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.25rem' }}>Student Accommodations & Accessibility</h3>
            <p style={{ margin: '4px 0 0', color: 'var(--text-muted, #64748b)', fontSize: '0.875rem' }}>
              Set individual time extensions for exams and checkpoints.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.5rem',
              cursor: 'pointer',
              color: 'var(--text-muted, #64748b)',
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div
              style={{
                background: '#fee2e2',
                color: '#b91c1c',
                padding: '10px 14px',
                borderRadius: '6px',
                marginBottom: '16px',
                fontSize: '0.875rem',
              }}
            >
              {error}
            </div>
          )}

          {/* Add / Edit Form */}
          <form onSubmit={handleSave} style={{ marginBottom: '24px' }}>
            <Card style={{ padding: '16px', background: 'var(--bg-muted, #f8fafc)' }}>
              <h4 style={{ margin: '0 0 12px', fontSize: '0.95rem' }}>Grant / Update Accommodation</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>
                    Select Student
                  </label>
                  <select
                    value={selectedUserId}
                    onChange={(e) => setSelectedUserId(Number(e.target.value) || '')}
                    required
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border, #cbd5e1)',
                    }}
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
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>
                    Time Multiplier
                  </label>
                  <select
                    value={multiplier}
                    onChange={(e) => setMultiplier(Number(e.target.value))}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border, #cbd5e1)',
                    }}
                  >
                    <option value={1.0}>1.0x (Standard)</option>
                    <option value={1.25}>1.25x (+25% time)</option>
                    <option value={1.5}>1.5x (Time & a half)</option>
                    <option value={2.0}>2.0x (Double time)</option>
                    <option value={3.0}>3.0x (Triple time)</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '12px', marginBottom: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>
                    Flat Extra Minutes
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="180"
                    value={extraMinutes}
                    onChange={(e) => setExtraMinutes(Number(e.target.value))}
                    placeholder="0"
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border, #cbd5e1)',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>
                    Reason / Documentation Notes
                  </label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. Accessibility services approved"
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border, #cbd5e1)',
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="submit" disabled={saving || !selectedUserId}>
                  {saving ? 'Saving...' : 'Save Accommodation'}
                </Button>
              </div>
            </Card>
          </form>

          {/* List of active accommodations */}
          <h4 style={{ margin: '0 0 12px', fontSize: '1rem' }}>Active Course Accommodations</h4>
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading accommodations...</p>
          ) : accommodations.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              No custom student accommodations configured for this course yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {accommodations.map((acc) => (
                <div
                  key={acc.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 16px',
                    border: '1px solid var(--border, #e2e8f0)',
                    borderRadius: '8px',
                    background: 'var(--bg, #ffffff)',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                      {acc.user_name || `User #${acc.user_id}`}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '8px', fontSize: '0.85rem' }}>
                        {acc.user_email}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
                      <Badge variant="primary">{acc.time_multiplier}x Time</Badge>
                      {acc.extra_minutes > 0 && <Badge variant="secondary">+{acc.extra_minutes} min</Badge>}
                      {acc.notes && (
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{acc.notes}</span>
                      )}
                    </div>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => handleDelete(acc.user_id)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border, #e2e8f0)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};
