// Select latest non-pinned video from user profile
// Called from user-profile-page adapter
export async function selectLatestWork(page) {
  const { findLatestNonPinnedVideo } = await import('../adapters/user-profile-page.mjs');
  return findLatestNonPinnedVideo(page);
}
