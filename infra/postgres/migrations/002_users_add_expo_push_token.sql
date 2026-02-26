-- Migration 002 — Phase 6: Notifications push
-- Adds expo_push_token column to users table for Expo Push Notification Service (EPNS)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS expo_push_token TEXT;

COMMENT ON COLUMN users.expo_push_token IS
  'Expo Push Notification token (ExponentPushToken[...]) — registered by the mobile app after notification permission is granted.';
