import { apiRequest } from './api';

export function createGroup({ name }, token) {
  return apiRequest('/groups', { method: 'POST', body: { name }, token });
}

export function joinGroup({ inviteCode }, token) {
  return apiRequest('/groups/join', { method: 'POST', body: { inviteCode }, token });
}

export function getMyGroups(token) {
  return apiRequest('/groups', { token });
}

export function getGroupDetails(id, token) {
  return apiRequest(`/groups/${id}`, { token });
}

export function leaveGroup(id, token) {
  return apiRequest(`/groups/${id}/leave`, { method: 'POST', token });
}

export function regenerateInvite(id, token) {
  return apiRequest(`/groups/${id}/regenerate-invite`, { method: 'POST', token });
}

export function promoteMember(groupId, userId, token) {
  return apiRequest(`/groups/${groupId}/promote/${userId}`, { method: 'POST', token });
}
