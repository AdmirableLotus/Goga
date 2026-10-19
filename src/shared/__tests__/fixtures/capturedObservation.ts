// Captured read-only run: .local-diagnostics/observation-collection-1792424717394.
// Replay data only; these tests perform no native observation or model inference.
export const capturedObservation = {
  request: 'What is in my active window? Don\u2019t click, type, or change anything.',
  identity: { title: 'Goga', owner: 'electron', pid: 27868, hwnd: 1378612 },
  ui: { window: { title: 'Goga', pid: 27868, hwnd: 1378612 }, texts: ['Goga', 'Chrome Legacy Window'], truncated: false },
  raw: '{"textIds":[0]}',
  reply: 'Active window: "Goga".\nProcess: "electron" (PID 27868).\nRetrieved accessibility text:\n- "Chrome Legacy Window"\nNo image was analyzed, so I cannot describe visual details.',
}
