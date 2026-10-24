/**
 * Node 22 載入 node:sqlite 時會在標準錯誤印出 ExperimentalWarning。agent 會把它誤認為錯誤，
 * 所以只隱藏這一則；其他警告照常顯示。必須是 CLI 入口第一個匯入的模組。
 */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  process.stderr.write(`(node:${process.pid}) ${w.name}: ${w.message}\n`);
});

export {};
