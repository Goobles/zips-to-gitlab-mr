# Zips to Gitlab Merge Request

This script is used to create merge requests in bulk in Gitlab from a bunch of zip files containing the changes.

## Pre-requisites

- Node.js 22.0.0 or higher
- Gitlab API token
- Gitlab project ID
- Git installed and added to the PATH

## Usage

1. Clone the repository
2. Install the dependencies via `npm install`
3. Create an `.env` file based on `.env.example` and fill in the required values
4. Place the zip files in the `zips` directory
5. Run the script via `npm run start`
