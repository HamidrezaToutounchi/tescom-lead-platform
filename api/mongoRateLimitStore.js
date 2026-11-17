'use strict';

const { RateLimitRecord } = require('./models');

class MongoRateLimitStore {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60 * 1000;
    this.prefix = options.prefix || 'rl:';
  }

  init(options) {
    if (options && options.windowMs) {
      this.windowMs = options.windowMs;
    }
  }

  _formatKey(key) {
    return `${this.prefix}${key}`;
  }

  async increment(rawKey) {
    const key = this._formatKey(rawKey);
    const now = new Date();
    const resetTime = new Date(Date.now() + this.windowMs);

    try {
      // 1. Try to increment within current active window
      let record = await RateLimitRecord.findOneAndUpdate(
        { key, resetTime: { $gt: now } },
        { $inc: { totalHits: 1 } },
        { new: true }
      );

      // 2. If no active record exists, create or reset with fresh window
      if (!record) {
        record = await RateLimitRecord.findOneAndUpdate(
          { key },
          { $set: { totalHits: 1, resetTime } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }

      return {
        totalHits: record.totalHits,
        resetTime: record.resetTime
      };
    } catch (err) {
      console.warn('[WARN] MongoRateLimitStore increment error:', err.message);
      // Graceful degradation in case of DB glitch
      return {
        totalHits: 1,
        resetTime
      };
    }
  }

  async decrement(rawKey) {
    const key = this._formatKey(rawKey);
    try {
      await RateLimitRecord.updateOne(
        { key, totalHits: { $gt: 0 } },
        { $inc: { totalHits: -1 } }
      );
    } catch (err) {
      console.warn('[WARN] MongoRateLimitStore decrement error:', err.message);
    }
  }

  async resetKey(rawKey) {
    const key = this._formatKey(rawKey);
    try {
      await RateLimitRecord.deleteOne({ key });
    } catch (err) {
      console.warn('[WARN] MongoRateLimitStore resetKey error:', err.message);
    }
  }

  async resetAll() {
    try {
      await RateLimitRecord.deleteMany({ key: { $regex: `^${this.prefix}` } });
    } catch (err) {
      console.warn('[WARN] MongoRateLimitStore resetAll error:', err.message);
    }
  }

  async get(rawKey) {
    const key = this._formatKey(rawKey);
    try {
      const record = await RateLimitRecord.findOne({
        key,
        resetTime: { $gt: new Date() }
      }).lean();

      if (!record) return undefined;
      return {
        totalHits: record.totalHits,
        resetTime: record.resetTime
      };
    } catch (err) {
      console.warn('[WARN] MongoRateLimitStore get error:', err.message);
      return undefined;
    }
  }
}

module.exports = MongoRateLimitStore;
