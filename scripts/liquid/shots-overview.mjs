#!/usr/bin/env node
// Screenshot of Liquid enterprise → Overview with the control loop health (ADR-0051), in steady state.
import path from 'node:path';
import { ADMIN, env, log, root } from '../sofa-company/lib.mjs';
import { Shots } from '../sofa-company/shots.mjs';

process.env.ADMIN_EMAIL = env.BOOTSTRAP_ADMIN_EMAIL;
process.env.ADMIN_PASSWORD = env.BOOTSTRAP_ADMIN_PASSWORD;
const shots = await new Shots(path.join(root, 'docs', 'images', 'liquid')).open();
await shots.snap(env.BOOTSTRAP_ADMIN_EMAIL, `${ADMIN}/liquid`, 'liquid-overview', { width: 1400, height: 1000, wait: 4000, fullPage: true });
await shots.close();
log('screenshot docs/images/liquid/liquid-overview.png');
