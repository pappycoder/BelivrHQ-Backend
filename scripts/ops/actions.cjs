'use strict';
// This is the complete console action list; removed tools are not CLI shortcuts.
module.exports = [
  { id: 'dev', label: 'Dev build (watch)', input: 'none' },
  { id: 'build', label: 'Production build' },
  { id: 'test', label: 'Run tests' },
  { id: 'migration-deploy', label: 'Deploy migrations (backs up first)', input: 'confirm' },
  { id: 'admin-super', label: 'Create super user', input: 'admin' },
  { id: 'admin-church', label: 'Create church admin', input: 'admin' },
  { id: 'subscription-switch', label: 'Switch subscription', input: 'subscription' },
];
