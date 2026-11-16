import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { environment } from '../config/runtime.js';
import { databaseOptions } from './options.js';

export default new DataSource(databaseOptions(environment));
