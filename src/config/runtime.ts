import 'dotenv/config';
import { parseEnvironment } from './environment.js';

export const environment = parseEnvironment(process.env);
