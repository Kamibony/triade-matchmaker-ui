import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import path from 'path';

describe('Local DB Setup', () => {
    it('should create database and insert mock data', () => {
         const dbPath = path.join(process.cwd(), 'local_oscs.db');
         const db = new Database(dbPath, { fileMustExist: true });

         const countQuery = db.prepare('SELECT COUNT(*) as count FROM oscs').get() as { count: number };
         assert.ok(countQuery.count > 0, 'Database should have records');

         const oscQuery = db.prepare("SELECT * FROM oscs WHERE uf='SP' LIMIT 1").get();
         assert.ok(oscQuery, 'Should retrieve an OSC from SP');

         db.close();
    });
});
