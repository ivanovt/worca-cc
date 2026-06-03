// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightImageZoom from 'starlight-image-zoom';

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

// Load JetBrains Mono (700) to match the worca-ui wordmark used in the header.
const fontHead = /** @type {const} */ ([
	{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
	{
		tag: 'link',
		attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
	},
	{
		tag: 'link',
		attrs: {
			rel: 'stylesheet',
			href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@700&display=swap',
		},
	},
]);

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.worca.dev',
	integrations: [
		starlight({
			plugins: [starlightImageZoom()],
			title: 'worca',
			description:
				'Documentation for worca — an autonomous software development pipeline combining orchestration with governance enforcement.',
			favicon: '/favicon.svg',
			customCss: ['./src/styles/worca.css'],
			// Hide the right-hand "On this page" rail site-wide (re-enable per page
			// with `tableOfContents: true` in frontmatter for long pages).
			tableOfContents: false,
			head: [...fontHead, ...analyticsHead],
			social: [{ icon: 'github', label: 'GitHub', href: GITHUB_REPO }],
			editLink: { baseUrl: `${GITHUB_REPO}/edit/master/docs-site/` },
			// Per-page "Last updated" date, derived from each file's git history.
			// Requires the CI build to have git history (a depth-1 shallow clone
			// makes every page show the deploy commit's date).
			lastUpdated: true,
			sidebar: [
				{ label: 'Introduction', items: [{ autogenerate: { directory: 'introduction' } }] },
				{ label: 'Getting started', items: [{ autogenerate: { directory: 'getting-started' } }] },
				{ label: 'Core concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
				{
					label: 'Running pipelines',
					items: [{ autogenerate: { directory: 'running-pipelines' } }],
				},
				{ label: 'Configuration', items: [{ autogenerate: { directory: 'configuration' } }] },
				{
					label: 'Notifications & integrations',
					items: [{ autogenerate: { directory: 'integrations' } }],
				},
				{ label: 'Advanced', items: [{ autogenerate: { directory: 'advanced' } }] },
				{ label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
				{ label: 'Upgrading', items: [{ autogenerate: { directory: 'upgrading' } }] },
			],
		}),
	],
});
