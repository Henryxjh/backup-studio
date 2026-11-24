import { spawnSync } from 'node:child_process';

const suites = [
  'test:engine',
  'test:aut',
  'test:gate',
  'test:recycle',
  'test:transaction',
  'test:dup',
  'test:reveal',
  'test:recycle-crash',
];

const npmCli = process.env.npm_execpath;
const failed = [];

if (!npmCli) {
  throw new Error('npm_execpath 未设置；请通过 npm test 运行测试调度器');
}

for (const suite of suites) {
  const result = spawnSync(process.execPath, [npmCli, 'run', suite], { stdio: 'inherit' });
  if (result.error) {
    console.error(`\n无法启动 ${suite}:`, result.error);
    failed.push(suite);
    continue;
  }
  if (result.status !== 0) failed.push(suite);
}

if (failed.length > 0) {
  console.error(`\n失败的测试套件（${failed.length}/${suites.length}）：${failed.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`\n全部 ${suites.length} 套测试通过`);
}
