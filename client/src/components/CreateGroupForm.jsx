import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { createGroup } from '../services/group.service';
import { ApiError } from '../services/api';
import ShareInviteBox from './ShareInviteBox.jsx';

function CreateGroupForm({ onCreated, onCancel }) {
  const { token } = useAuth();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [createdGroup, setCreatedGroup] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;

    if (!name.trim()) {
      setError('Group name is required.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const data = await createGroup({ name: name.trim() }, token);
      setCreatedGroup(data.group);
      onCreated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create group.');
    } finally {
      setSubmitting(false);
    }
  }

  // Success state: show the Google Meet-style share box with WhatsApp, Copy Link & Code
  if (createdGroup) {
    return (
      <div className="space-y-3">
        <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-xs font-semibold text-emerald-900 flex items-center gap-2">
          <span>✅</span>
          <span>&quot;{createdGroup.name}&quot; created successfully! Invite riders below:</span>
        </div>
        <ShareInviteBox
          groupName={createdGroup.name}
          inviteCode={createdGroup.inviteCode}
          onDone={onCancel}
        />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="border border-slate-200 rounded-lg p-4 space-y-3">
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="groupName" className="block text-sm font-medium text-slate-700 mb-1">
          Group Name
        </label>
        <input
          id="groupName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Weekend Kerala Ride"
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
      </div>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-slate-900 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Creating...' : 'Create'}
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

export default CreateGroupForm;
