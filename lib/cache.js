// Packages
const fetch = require('node-fetch')
const retry = require('async-retry')
const convertStream = require('stream-to-string')
const ms = require('ms')

// Utilities
const checkPlatform = require('./platform')

module.exports = class Cache {
  constructor(config) {
    const { account, repository, token, url } = config
    this.config = config

    if (!account || !repository) {
      const error = new Error('Neither ACCOUNT, nor REPOSITORY are defined')
      error.code = 'missing_configuration_properties'
      throw error
    }

    if (token && !url) {
      const error = new Error(
        'Neither VERCEL_URL, nor URL are defined, which are mandatory for private repo mode'
      )
      error.code = 'missing_configuration_properties'
      throw error
    }

    this.latest = {}
    this.prerelease = {}

    this.channel = 'stable'

    this.lastUpdateStable = null
    this.lastUpdateBeta = null

    this.cacheReleaseList = this.cacheReleaseList.bind(this)
    this.refreshCache = this.refreshCache.bind(this)
    this.loadCache = this.loadCache.bind(this)
    this.isOutdated = this.isOutdated.bind(this)
  }

  async cacheReleaseList(url) {
    const { token } = this.config
    const headers = { Accept: 'application/vnd.github.preview' }

    if (token && typeof token === 'string' && token.length > 0) {
      headers.Authorization = `token ${token}`
    }

    const { status, body } = await retry(
      async () => {
        const response = await fetch(url, { headers })

        if (response.status !== 200) {
          throw new Error(
            `Tried to cache RELEASES, but failed fetching ${url}, status ${status}`
          )
        }

        return response
      },
      { retries: 3 }
    )

    let content = await convertStream(body)
    const matches = content.match(/[^ ]*\.nupkg/gim)

    if (matches.length === 0) {
      throw new Error(
        `Tried to cache RELEASES, but failed. RELEASES content doesn't contain nupkg`
      )
    }

    for (let i = 0; i < matches.length; i += 1) {
      const nuPKG = url.replace('RELEASES', matches[i])
      content = content.replace(matches[i], nuPKG)
    }
    return content
  }

  async refreshCache() {
    console.log('Refreshing cache...')
    const { account, repository, pre, token } = this.config
    const repo = account + '/' + repository
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100`
    const headers = { Accept: 'application/vnd.github.preview' }

    if (token && typeof token === 'string' && token.length > 0) {
      headers.Authorization = `token ${token}`
    }

    const response = await retry(
      async () => {
        const response = await fetch(url, { headers })

        if (response.status !== 200) {
          throw new Error(
            `GitHub API responded with ${response.status} for url ${url}`
          )
        }

        return response
      },
      { retries: 3 }
    )

    const data = await response.json()

    if (!Array.isArray(data) || data.length === 0) {
      return
    }

    const release = data.find(item => {
      const isPre = Boolean(pre || this.channel === 'prerelease') === Boolean(item.prerelease)
      return !item.draft && isPre
    })

    if (!release || !release.assets || !Array.isArray(release.assets)) {
      return
    }

    const { tag_name } = release

    const channel = this[this.channel === 'prerelease' ? 'prerelease' : 'latest']

    console.log('Latest version is', {
      channelVersion: channel.version,
      tag_name
    })
    if (channel.version === tag_name) {
      console.log('Cached version is the same as latest')
      switch (this.channel) {
        case 'stable':
          this.lastUpdateStable = Date.now()
          break;
        case 'beta':
          this.lastUpdateBeta = Date.now()
          break;
      }
      return
    }

    console.log(`Caching version ${tag_name}...`)

    channel.version = tag_name
    channel.notes = release.body
    channel.pub_date = release.published_at

    // Clear list of download links
    channel.platforms = {}

    for (const asset of release.assets) {
      const { name, browser_download_url, url, content_type, size } = asset

      if (name === 'RELEASES') {
        try {
          if (!channel.files) {
            channel.files = {}
          }
          channel.files.RELEASES = await this.cacheReleaseList(
            browser_download_url
          )
        } catch (err) {
          console.error(err)
        }
        continue
      }

      const platform = checkPlatform(name)

      if (!platform) {
        continue
      }

      channel.platforms[platform] = {
        name,
        api_url: url,
        url: browser_download_url,
        content_type,
        size: Math.round(size / 1000000 * 10) / 10
      }
    }

    console.log(`Finished caching version ${tag_name}`)

    switch (this.channel) {
      case 'stable':
        this.lastUpdateStable = Date.now()
        break;
      case 'prerelease':
        this.lastUpdateBeta = Date.now()
        break;
    }
  }

  isOutdated() {
    const { config } = this
    const { interval = 15 } = config

    const lastUpdate = this.channel === 'stable' ? this.lastUpdateStable : this.lastUpdateBeta

    if (lastUpdate && Date.now() - lastUpdate > ms(`${interval}m`)) {
      return true
    }

    return false
  }

  // This is a method returning the cache
  // because the cache would otherwise be loaded
  // only once when the index file is parsed
  async loadCache({ allowPreReleases = false }) {
    const { latest, prerelease, refreshCache, isOutdated, lastUpdateStable, lastUpdateBeta } = this
    this.channel = allowPreReleases ? 'prerelease' : 'stable'

    console.log({
      lastUpdateBeta, lastUpdateStable, isOutdated: isOutdated(),
      test: !(this.channel === 'stable' ? Boolean(lastUpdateStable) : Boolean(lastUpdateBeta)),
      test2: !(this.channel === 'stable' ? Boolean(lastUpdateStable) : Boolean(lastUpdateBeta)) || isOutdated()
    })

    if (!(this.channel === 'stable' ? Boolean(lastUpdateStable) : Boolean(lastUpdateBeta)) || isOutdated()) {
      await refreshCache()
    }

    return Object.assign({}, allowPreReleases ? prerelease : latest)
  }
}
