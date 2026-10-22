import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { joinGroup } from '../services/group.service';
import { ApiError } from '../services/api';

function JoinGroupForm({ onJoined, onCancel }) {
  const { token } = useAuth();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;

    const trimmed = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(trimmed)) {
      setError('Enter the 6-character invite code.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const data = await joinGroup({ inviteCode: trimmed }, token);
      setSuccess(`Joined "${data.group.name}".`);
      onJoined?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join group.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-slate-200 rounded-lg p-4 space-y-3">
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}
      {success && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
          {success}
        </div>
      )}
      <div>
        <label htmlFor="inviteCode" className="block text-sm font-medium text-slate-700 mb-1">
          Invite Code
        </label>
        <input
          id="inviteCode"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="A7K9PX"
          maxLength={6}
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
      </div>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-slate-900 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Joining...' : 'Join'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default JoinGroupForm;
