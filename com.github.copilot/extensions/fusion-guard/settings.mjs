// joinSession returns a session, not the client exposing server-scoped user
// settings. Use its existing transport; this property is SDK-private in types.
function request(session, method, params) {
  if (typeof session.connection?.sendRequest !== 'function') {
    throw new Error('This Copilot SDK does not expose the attached transport required for native user settings.');
  }
  return session.connection.sendRequest(method, params);
}

export const getUserSettings = (session) => request(session, 'user.settings.get', {});
export const setUserSettings = (session, settings) => request(session, 'user.settings.set', { settings });
