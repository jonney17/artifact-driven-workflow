import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { decidePermission, hostAllowed, sessionEnv, simpleCommands } from '../src/policy';
import { AllowlistProxy } from '../src/proxy';
import type { AttemptRequest } from '../src/runner';

const devPolicy: AttemptRequest['policy'] = {
  tools: ['read', 'edit', 'search', 'shell:build', 'shell:unit', 'ask_human'],
  maxTurns: 60,
  writeAllow: ['**'],
  writeDeny: ['${test_dirs}/**', '.sdlc/**'],
  sensitivePaths: ['**/pom.xml', '.gitlab-ci.yml'],
  unlocked: [],
  vars: { test_dirs: ['src/acceptance'] },
  shellCommands: { build: 'mvn -q verify', unit: 'mvn test' },
  networkAllow: ['api.githubcopilot.com', '*.githubcopilot.com', 'repo.maven.apache.org', 'localhost'],
};
const wd = 'C:/work/wt/developer_PAY-1_api/a1';

describe('tool policy (onPermissionRequest)', () => {
  const allow = (req: Parameters<typeof decidePermission>[0], p = devPolicy) => decidePermission(req, p, wd).allow;

  it('reads only inside the worktree', () => {
    expect(allow({ kind: 'read', path: 'src/App.java' })).toBe(true);
    expect(allow({ kind: 'read', path: `${wd}/src/App.java` })).toBe(true);
    expect(allow({ kind: 'read', path: 'C:/Users/dev/.ssh/id_rsa' })).toBe(false);
    expect(allow({ kind: 'read', path: '../../other/secret' })).toBe(false);
  });

  it('writes follow write scope and sensitive paths', () => {
    expect(allow({ kind: 'write', path: 'src/main/App.java' })).toBe(true);
    expect(allow({ kind: 'write', path: 'src/acceptance/AppIT.java' })).toBe(false);
    expect(allow({ kind: 'write', path: 'pom.xml' })).toBe(false);
    expect(allow({ kind: 'write', path: 'pom.xml' }, { ...devPolicy, unlocked: ['pom.xml'] })).toBe(true);
    expect(allow({ kind: 'write', path: 'src/App.java' }, { ...devPolicy, tools: ['read'] })).toBe(false);
  });

  it('shell: only configured programs and local git; no push; chained commands are checked one by one', () => {
    expect(allow({ kind: 'shell', command: 'mvn -q verify' })).toBe(true);
    expect(allow({ kind: 'shell', command: 'mvn test -Dtest=AppTest' })).toBe(true);
    expect(allow({ kind: 'shell', command: 'git status && git commit -m x' })).toBe(true);
    expect(allow({ kind: 'shell', command: 'git push origin HEAD' })).toBe(false);
    expect(allow({ kind: 'shell', command: 'mvn test && curl http://evil' })).toBe(false);
    expect(allow({ kind: 'shell', command: 'mvn test; rm -rf /' })).toBe(false);
    expect(allow({ kind: 'shell', command: 'echo $(cat ~/.ssh/id_rsa)' })).toBe(false);
    expect(simpleCommands('a && b | c; d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('web is off unless the contract has it, then allowlisted hosts only; MCP and unknown tools never', () => {
    expect(allow({ kind: 'url', url: 'https://api.githubcopilot.com/x' })).toBe(false);
    const web = { ...devPolicy, tools: [...devPolicy.tools, 'web'] };
    expect(allow({ kind: 'url', url: 'https://repo.maven.apache.org/maven2' }, web)).toBe(true);
    expect(allow({ kind: 'url', url: 'https://corp.atlassian.net/rest' }, web)).toBe(false);
    expect(allow({ kind: 'mcp', server: 'gitlab', tool: 'create_merge_request' })).toBe(false);
    expect(allow({ kind: 'custom-tool', name: 'ask_human' })).toBe(true);
    expect(allow({ kind: 'custom-tool', name: 'jira_comment' })).toBe(false);
  });

  it('host allowlist wildcards', () => {
    expect(hostAllowed('proxy.business.githubcopilot.com', ['*.githubcopilot.com'])).toBe(true);
    expect(hostAllowed('githubcopilot.com', ['*.githubcopilot.com'])).toBe(true);
    expect(hostAllowed('evilgithubcopilot.com', ['*.githubcopilot.com'])).toBe(false);
  });
});

describe('session environment', () => {
  it('drops tokens and secrets, disables git credentials, sets the proxy', () => {
    const env = sessionEnv(
      { PATH: '/bin', HOME: '/home/bob', JAVA_HOME: '/jdk', GITLAB_TOKEN: 'glpat-x', JIRA_API_TOKEN: 'y', AWS_SECRET_ACCESS_KEY: 'z', GH_TOKEN: 'ghp', SSH_AUTH_SOCK: '/tmp/ssh', RANDOM: '1' },
      { proxyUrl: 'http://127.0.0.1:4567' },
    );
    expect(env.PATH).toBe('/bin');
    expect(env.JAVA_HOME).toBe('/jdk');
    for (const k of ['GITLAB_TOKEN', 'JIRA_API_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'RANDOM']) expect(env[k]).toBeUndefined();
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', HTTPS_PROXY: 'http://127.0.0.1:4567' });
    expect(env.MAVEN_OPTS).toContain('-Dhttps.proxyPort=4567');
  });
});

describe('allowlisting proxy', () => {
  it('forwards allowlisted hosts and blocks the rest (HTTP and CONNECT)', async () => {
    const upstream = createServer((_req, res) => res.end('hello from upstream'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    const proxy = new AllowlistProxy(['127.0.0.1']);
    const url = new URL(await proxy.start());
    const viaProxy = (target: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: url.hostname, port: url.port, path: target, method: 'GET', headers: { host: new URL(target).host } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    const connectTo = (hostport: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: url.hostname, port: url.port, method: 'CONNECT', path: hostport });
        req.on('connect', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await viaProxy(`http://127.0.0.1:${port}/x`)).toEqual({ status: 200, body: 'hello from upstream' });
      expect((await viaProxy('http://evil.example/x')).status).toBe(403);
      expect(await connectTo(`127.0.0.1:${port}`)).toBe(200);
      expect(await connectTo('evil.example:443')).toBe(403);
      expect(proxy.log.map((l) => [l.host, l.allowed])).toEqual([
        ['127.0.0.1', true],
        ['evil.example', false],
        ['127.0.0.1', true],
        ['evil.example', false],
      ]);
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });
});
