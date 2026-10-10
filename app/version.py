"""Version and release metadata. The release workflow overwrites __version__ from the git tag."""

__version__ = "0.1.0"

APP_NAME = "Tamkeen"
# Internal id (data folder and executable name). Kept from the app's first name, "Arabic Podcast
# Studio", so updates keep finding existing libraries and install over the old version.
APP_ID = "ArabicPodcastStudio"

# GitHub repository used by the in-app update check ("owner/name").
GITHUB_REPO = "OWNER/tamkeen"
