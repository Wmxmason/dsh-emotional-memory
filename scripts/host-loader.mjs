import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.DSH_SDK_ROOT) throw new Error('Set DSH_SDK_ROOT to an installed Harness runtime root');
const hostParent = pathToFileURL(join(process.env.DSH_SDK_ROOT, 'package.json')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL: hostParent });
  }
  if (specifier === '@tencent-connect/dsh-qqbot' && process.env.DSH_QQ_ROOT) {
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(process.env.DSH_QQ_ROOT, 'package.json')).href });
  }
  return nextResolve(specifier, context);
} });
