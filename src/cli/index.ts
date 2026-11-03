#!/usr/bin/env node
// 先換掉 warning 處理器，再載入主程式：node:sqlite 在載入階段就會發出 ExperimentalWarning，
// 主程式若是靜態匯入，警告會比過濾器先出現。
import './warnings.js';

await import('./main.js');
