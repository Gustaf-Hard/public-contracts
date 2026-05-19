#!/usr/bin/env node
import 'dotenv/config';
import { startDaemon } from '../src/daemon.js';
await startDaemon({ env: process.env });
