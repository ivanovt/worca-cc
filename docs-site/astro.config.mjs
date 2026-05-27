// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const GITHUB_REPO = 'https://github.com/SinishaDjukic/worca-cc';

// Cloudflare Web Analytics beacon. Injected only when the token is provided at
// build time via PUBLIC_CF_BEACON_TOKEN (set as a Workers Builds env var). This
// keeps the token out of git and lets preview/production stay independent.
const cfBeaconToken = process.env.PUBLIC_CF_BEACON_TOKEN;
const analyticsHead = cfBeaconToken
	? [
			/** @type {const} */ ({
				tag: 'script',
				attrs: {
					defer: true,
					src: 'https://static.cloudflareinsights.com/beacon.min.js',
					'data-cf-beacon': JSON.stringify({ token: cfBeaconToken }),
				},
			}),
		]
	: [];

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.worca.dev',
	integrations: [
		starlight({
			title: 'worca',
			description:
				'Documentation for worca — an autonomous software development pipeline combining orchestration with governance enforcement.',
			favicon: '/favicon.svg',
			customCss: ['./src/styles/worca.css'],
			head: analyticsHead,
			social: [{ icon: 'github', label: 'GitHub', href: GITHUB_REPO }],
			editLink: { baseUrl: `${GITHUB_REPO}/edit/master/docs-site/` },
			// Content phase, Wave 1. Groups are added as their pages land.
			sidebar: [
				{ label: 'Introduction', items: [{ autogenerate: { directory: 'introduction' } }] },
				{ label: 'Getting started', items: [{ autogenerate: { directory: 'getting-started' } }] },
				// Upcoming: Core concepts, Running pipelines, Configuration,
				// Notifications & integrations, Advanced, Reference, Upgrading.
			],
		}),
	],
});
