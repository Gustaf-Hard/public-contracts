import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTiles } from '../scripts/16-fetch-kommun-stats.js';

const cells = (tiles) => Object.values(tiles).map((t) => `${t.x},${t.y}`);

describe('buildTiles', () => {
  // three points at the same spot plus two apart, on a tiny grid
  const pts = [
    { kod: 'A', lon: 10, lat: 60, weight: 100 },
    { kod: 'B', lon: 10, lat: 60, weight: 50 },
    { kod: 'C', lon: 10, lat: 60, weight: 10 },
    { kod: 'D', lon: 20, lat: 50, weight: 5 },
    { kod: 'E', lon: 20, lat: 60, weight: 1 },
  ];
  it('gives every kommun a unique cell inside the grid', () => {
    const { tiles, cols, rows } = buildTiles(pts, { cols: 4, rows: 4 });
    expect(Object.keys(tiles).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(new Set(cells(tiles)).size).toBe(5);
    for (const t of Object.values(tiles)) {
      expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x).toBeLessThan(cols);
      expect(t.y).toBeGreaterThanOrEqual(0); expect(t.y).toBeLessThan(rows);
    }
  });
  it('is deterministic', () => {
    const a = buildTiles(pts, { cols: 4, rows: 4 }).tiles;
    const b = buildTiles([...pts].reverse(), { cols: 4, rows: 4 }).tiles;
    expect(b).toEqual(a);
  });
  it('largest keeps the ideal cell, colliders take a free neighbour', () => {
    const { tiles } = buildTiles(pts, { cols: 4, rows: 4 });
    expect(tiles.A).toEqual({ x: 0, y: 0 });
    for (const k of ['B', 'C']) {
      const d = Math.hypot(tiles[k].x - tiles.A.x, tiles[k].y - tiles.A.y);
      expect(d).toBeLessThanOrEqual(2);
    }
  });
  it('throws when the grid is too small', () => {
    expect(() => buildTiles(pts, { cols: 2, rows: 2 })).toThrow(/too small/);
  });
});

describe('committed kommun-tiles.json', () => {
  const j = JSON.parse(readFileSync(new URL('../public/geo/kommun-tiles.json', import.meta.url), 'utf8'));
  it('has 290 tiles in bounds with unique cells', () => {
    expect(Object.keys(j.tiles)).toHaveLength(290);
    for (const t of Object.values(j.tiles)) {
      expect(Number.isInteger(t.x) && t.x >= 0 && t.x < j.cols).toBe(true);
      expect(Number.isInteger(t.y) && t.y >= 0 && t.y < j.rows).toBe(true);
    }
    expect(new Set(cells(j.tiles)).size).toBe(290);
  });
});
