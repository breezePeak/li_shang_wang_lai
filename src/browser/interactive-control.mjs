import readline from 'readline';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function promptRecoveryAction(step, code, message, evidenceDir) {
  console.error('');
  console.error(`[BLOCKED] ${code}`);
  console.error(`  错误步骤: ${step}`);
  console.error(`  信息: ${message}`);
  console.error('');
  console.error(`  现场证据已保存: ${evidenceDir}`);
  console.error('');
  console.error('  浏览器已保持打开。你可以手动进入正确页面后重新检测。');
  console.error('');
  console.error('  请选择：');
  console.error('    [r] 重新检测当前页面');
  console.error('    [s] 跳过当前步骤');
  console.error('    [d] 再保存一次诊断信息');
  console.error('    [q] 安全退出并关闭浏览器');
  console.error('    [k] 安全退出但保持浏览器打开');

  for (;;) {
    try {
      const answer = await prompt('  > ');

      switch (answer) {
        case 'r': return { action: 'retry' };
        case 's': return { action: 'skip' };
        case 'd': return { action: 'diagnose' };
        case 'q': return { action: 'quit-close' };
        case 'k': return { action: 'quit-keep-open' };
        default:
          console.error('  无效选择，请输入 r/s/d/q/k');
      }
    } catch {
      return { action: 'quit-keep-open' };
    }
  }
}

export async function promptForEnter(message = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}
