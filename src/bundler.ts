/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
import * as path from 'path';
import * as urlLib from 'url';
const pathPosix = path.posix;
import * as dom5 from 'dom5';
import encodeString from './third_party/UglifyJS2/encode-string';

import * as parse5 from 'parse5';
import {ASTNode} from 'parse5';
import {Analyzer, Options as AnalyzerOptions} from 'polymer-analyzer';
import {Document, ScannedDocument} from 'polymer-analyzer/lib/model/document';
import {Import} from 'polymer-analyzer/lib/model/import';
import {ParsedHtmlDocument} from 'polymer-analyzer/lib/html/html-document';
import {FSUrlLoader} from 'polymer-analyzer/lib/url-loader/fs-url-loader';
import constants from './constants';
import * as astUtils from './ast-utils';
import * as importUtils from './import-utils';
import * as matchers from './matchers';
import * as urlUtils from './url-utils';
import {Bundle, BundleStrategy, AssignedBundle, generateBundles, BundleUrlMapper, BundleManifest, sharedBundleUrlMapper, generateSharedDepsMergeStrategy} from './bundle-manifest';
import {BundledDocument, DocumentCollection} from './document-collection';
import {buildDepsIndex} from './deps-index';
import {UrlString} from './url-utils';

// TODO(usergenic): Document every one of these options.
export interface Options {
  // When provided, relative paths will be converted to absolute paths where
  // `basePath` is the root url.  This path is equal to the folder of the
  // bundled url document of the analyzer.
  //
  // TODO(usergenic): If multiple `bundle()` calls are made `basePath` can
  // produce incompatile absolute paths if the same `basePath` is used for
  // `bundle()` targets in different folders.  Possible solutions include
  // removing basePath behavior altogether or supplementing it with a `rootPath`
  // or other hint to fix the top-level folder.
  basePath?: string;

  // TODO(usergenic): Added Imports is not yet supported.
  addedImports?: string[];

  // The instance of the Polymer Analyzer which has completed analysis
  analyzer?: Analyzer;

  // URLs of files that should not be inlined.
  excludes?: string[];

  // *DANGEROUS*! Avoid stripping imports of the transitive dependencies of
  // excluded imports (i.e. where listed in `excludes` option or where contained
  // in a folder/descendant of the `excludes` array.)  May result in duplicate
  // javascript inlining.
  noImplicitStrip?: boolean;

  // When true, inline external CSS file contents into <style> tags in the
  // output document.
  inlineCss?: boolean;

  // When true, inline external Javascript file contents into <script> tags in
  // the output document.
  inlineScripts?: boolean;

  // TODO(usergenic): Not-Yet-Implemented- document when supported.
  inputUrl?: string;

  // Remove of all comments (except those containing '@license') when true.
  stripComments?: boolean;

  // Paths of files that should not be inlined and which should have all links
  // removed.
  stripExcludes?: string[];
}

export class Bundler {
  basePath?: string;
  addedImports: string[];
  analyzer: Analyzer;
  enableCssInlining: boolean;
  enableScriptInlining: boolean;
  excludes: string[];
  implicitStrip: boolean;
  inputUrl: string;
  stripComments: boolean;
  stripExcludes: string[];

  constructor(options?: Options) {
    const opts = options ? options : {};
    this.analyzer = opts.analyzer ?
        opts.analyzer :
        new Analyzer({urlLoader: new FSUrlLoader()});

    // implicitStrip should be true by default
    this.implicitStrip = !Boolean(opts.noImplicitStrip);

    this.basePath = opts.basePath;

    this.addedImports =
        Array.isArray(opts.addedImports) ? opts.addedImports : [];
    this.excludes = Array.isArray(opts.excludes) ? opts.excludes : [];
    this.stripComments = Boolean(opts.stripComments);
    this.enableCssInlining = Boolean(opts.inlineCss);
    this.enableScriptInlining = Boolean(opts.inlineScripts);
    this.inputUrl =
        String(opts.inputUrl) === opts.inputUrl ? opts.inputUrl : '';
  }

  /**
   * Given a URL to an entry-point html document, produce a single document
   * with HTML imports, external stylesheets and external scripts inlined,
   * according to the options for this Bundler.
   *
   * TODO: Given Multiple urls, produces a sharded build by applying the
   * provided
   * strategy.
   *
   * @param {Array<string>} entrypoints The list of entrypoints that will be
   *     analyzed for dependencies. The results of the analysis will be passed
   *     to the `strategy`. An array of length 1 will bypass the strategy and
   *     directly bundle the document.
   * @param {BundleStrategy} strategy The strategy used to construct the
   *     output bundles. See 'polymer-analyzer/lib/bundle-manifest' for
   *     examples. UNUSED.
   */
  async bundle(
      entrypoints: string[],
      strategy?: BundleStrategy,
      mapper?: BundleUrlMapper): Promise<DocumentCollection> {
    const bundledDocuments: DocumentCollection =
        new Map<string, BundledDocument>();
    if (entrypoints.length === 1) {
      const url = entrypoints[0];
      const depsIndex = await buildDepsIndex(entrypoints, this.analyzer);
      const bundles = generateBundles(depsIndex.entrypointToDeps);
      for (const exclude of this.excludes) {
        bundles[0].files.delete(exclude);
      }
      const manifest =
          new BundleManifest(bundles, () => new Map([[url, bundles[0]]]));
      const bundle = {
        url: url,
        bundle: bundles[0],
      };
      const doc = await this._bundleDocument(bundle, manifest);
      bundledDocuments.set(
          url, {ast: doc, files: Array.from(bundles[0].files)});
      return bundledDocuments;
    } else {
      const bundles = new Map<string, ASTNode>();
      if (!strategy) {
        strategy = generateSharedDepsMergeStrategy(2);
      }
      if (!mapper) {
        mapper = sharedBundleUrlMapper;
      }
      const index = await buildDepsIndex(entrypoints, this.analyzer);
      const basicBundles = generateBundles(index.entrypointToDeps);
      const bundlesAfterStrategy = strategy(basicBundles);
      const manifest = new BundleManifest(bundlesAfterStrategy, mapper);
      for (const bundleEntry of manifest.bundles) {
        const bundleUrl = bundleEntry[0];
        const bundle = {url: bundleUrl, bundle: bundleEntry[1]};
        const bundledAst =
            await this._bundleDocument(bundle, manifest, bundle.bundle.files);
        bundledDocuments.set(
            bundleUrl,
            {ast: bundledAst, files: Array.from(bundle.bundle.files)});
      }
      return bundledDocuments;
    }
  }

  /**
   * Inline external script content into their tags, converting
   * `<script src="..."></script>`  tags to `<script>...</script>` tags.
   */
  async inlineScript(docUrl: string, externalScript: ASTNode) {
    return importUtils.inlineScript(
        docUrl,
        externalScript,
        url => this.analyzer.analyze(url).then(
            doc => doc.parsedDocument.contents));
  }

  /**
   * Inline a stylesheet (either from deprecated polymer-style css import `<link
   * rel="import" type="css">` import or regular external stylesheet link
   * `<link rel="stylesheet">`.
   */
  async inlineStylesheet(docUrl: string, cssLink: ASTNode) {
    return await importUtils.inlineStylesheet(
        this.basePath,
        docUrl,
        cssLink,
        url => this.analyzer.analyze(url).then(
            doc => doc.parsedDocument.contents));
  }

  /**
   * Inline external HTML files `<link type="import" href="...">`
   * TODO(usergenic): Refactor method to simplify and encapsulate case handling
   *     for hidden div adjacency etc.
   */
  async inlineHtmlImport(
      docUrl: string,
      htmlImport: ASTNode,
      reachedImports: Set<string>,
      bundle: AssignedBundle,
      manifest: BundleManifest) {
    const rawUrl: string = dom5.getAttribute(htmlImport, 'href')!;
    const resolvedUrl: string = urlLib.resolve(docUrl, rawUrl);
    const bundleUrl = manifest.bundleUrlForFile.get(resolvedUrl);

    // Don't reprocess the same file again.
    if (reachedImports.has(resolvedUrl)) {
      astUtils.removeElementAndNewline(htmlImport);
      return;
    }

    // If we can't find a bundle for the referenced import, record that we've
    // processed it, but don't remove the import link.  Browser will handle it.
    if (!bundleUrl) {
      reachedImports.add(resolvedUrl);
      return;
    }

    // Don't inline an import into itself.
    if (docUrl === resolvedUrl) {
      reachedImports.add(resolvedUrl);
      astUtils.removeElementAndNewline(htmlImport);
      return;
    }

    // Guard against inlining a import we've already processed.
    if (reachedImports.has(bundleUrl)) {
      astUtils.removeElementAndNewline(htmlImport);
      return;
    }

    // If the html import refers to a file which is bundled and has a different
    // url, then lets just rewrite the href to point to the bundle url.
    if (bundleUrl !== bundle.url) {
      const relative = urlUtils.relativeUrl(docUrl, bundleUrl) || bundleUrl;
      dom5.setAttribute(htmlImport, 'href', relative);
      reachedImports.add(bundleUrl);
      return;
    }

    const document =
        dom5.nodeWalkAncestors(htmlImport, (node) => !node.parentNode)!;
    const body = dom5.query(document, matchers.body)!;
    const analyzedImport = await this.analyzer.analyze(resolvedUrl);

    // If the document wasn't loaded for the import during analysis, we can't
    // inline it.
    if (!analyzedImport) {
      // TODO(usergenic): What should the behavior be when we don't have the
      // document to inline available in the analyzer?
      throw new Error(`Unable to analyze ${resolvedUrl}`);
    }

    // Is there a better way to get what we want other than using
    // parseFragment?
    const importDoc =
        parse5.parseFragment(analyzedImport.parsedDocument.contents);
    importUtils.rewriteImportedUrls(
        this.basePath, importDoc, resolvedUrl, docUrl);
    const nestedImports = dom5.queryAll(importDoc, matchers.htmlImport);

    // Move all of the import doc content after the html import.
    astUtils.insertAllBefore(
        htmlImport.parentNode!, htmlImport, importDoc.childNodes!);
    astUtils.removeElementAndNewline(htmlImport);

    // If we've never seen this import before, lets add it to the set so we
    // will deduplicate if we encounter it again.
    reachedImports.add(resolvedUrl);

    // Recursively process the nested imports.
    for (const nestedImport of nestedImports) {
      await this.inlineHtmlImport(
          docUrl, nestedImport, reachedImports, bundle, manifest);
    }
  }

  /**
   * Check the document for references to the old `<polymer-element>` custom
   * element.  If one is found, throw an error calling it out.
   * TODO(usergenic): Migrate "Old Polymer" detection to polymer-analyzer with
   * deprecated feature scanners.
   * TODO(usergenic): This behavior is a bit severe and would prevent developers
   * from using their own custom element named polymer-element, which they may
   * choose to do for unrelated reasons.
   */
  oldPolymerCheck(analyzedRoot: Document) {
    analyzedRoot.getByKind('document').forEach((d) => {
      if (d.parsedDocument instanceof ParsedHtmlDocument &&
          dom5.query(d.parsedDocument.ast, matchers.polymerElement)) {
        throw new Error(
            constants.OLD_POLYMER + ' File: ' + d.parsedDocument.url);
      }
    });
  }

  /**
   * Add HTML Import elements for each file in the bundle.  We append all the
   * imports in the case any were moved into the bundle by the strategy.
   * While this will almost always yield duplicate imports, they will be
   * cleaned up through deduplication during the import phase.
   */
  private _appendHtmlImportsForBundle(
      document: ASTNode,
      bundle: AssignedBundle) {
    for (const importUrl of bundle.bundle.files) {
      const newUrl = urlUtils.relativeUrl(bundle.url, importUrl);
      if (!newUrl) {
        continue;
      }
      this._appendImport(this._findOrCreateHiddenDiv(document), newUrl);
    }
    return document;
  }

  /**
   * Append a <link rel="import" node to `node` with a value of `url` for
   * the "href" attribute.
   */
  private _appendImport(node: ASTNode, url: UrlString): ASTNode {
    const newNode = dom5.constructors.element('link');
    dom5.setAttribute(newNode, 'rel', 'import');
    dom5.setAttribute(newNode, 'href', url);
    dom5.append(node, newNode);
    return newNode;
  }

  /**
   * Set the hidden div at the appropriate location within the document.  The
   * goal is to place the hidden div at the same place as the first html
   * import.  However, the div can't be placed in the `<head>` of the document
   * so if first import is found in the head, we prepend the div to the body.
   * If there is no body, we'll just attach the hidden div to the document at
   * the end.
   */
  private _attachHiddenDiv(document: ASTNode, hiddenDiv: ASTNode) {
    const firstHtmlImport = dom5.query(document, matchers.htmlImport);
    const body = dom5.query(document, matchers.body);
    if (body) {
      if (firstHtmlImport &&
          dom5.predicates.parentMatches(matchers.body)(firstHtmlImport)) {
        astUtils.insertAfter(firstHtmlImport, hiddenDiv);
      } else {
        astUtils.prepend(body, hiddenDiv);
      }
    } else {
      dom5.append(document, hiddenDiv);
    }
  }

  /**
   * TODO(garlicnation): resolve <base> tags.
   * TODO(garlicnation): find transitive dependencies of specified excluded
   * files.
   * TODO(garlicnation): ignore <link> in <template>
   * TODO(garlicnation): Support addedImports
   *
   * SAVED FROM buildLoader COMMENTS
   * TODO(garlicnation): Add noopResolver for external urls.
   * TODO(garlicnation): Add redirectResolver for fakeprotocol:// urls
   * TODO(garlicnation): Add noopResolver for excluded urls.
   */
  private async _bundleDocument(
      bundle: AssignedBundle,
      bundleManifest: BundleManifest,
      bundleImports?: Set<string>): Promise<ASTNode> {
    const url = bundle.url;
    const document = await this._prepareBundleDocument(bundle);
    this._appendHtmlImportsForBundle(document, bundle);
    let analyzedRoot: any;
    try {
      analyzedRoot =
          await this.analyzer.analyze(url, parse5.serialize(document));
    } catch (err) {
      throw new Error('Unable to analyze document!');
    }

    const head: ASTNode = dom5.query(document, matchers.head)!;
    const body: ASTNode = dom5.query(document, matchers.body)!;

    const elementInHead = dom5.predicates.parentMatches(matchers.head);

    importUtils.rewriteImportedUrls(this.basePath, document, url, url);

    // Old Polymer versions are not supported, so warn user.
    this.oldPolymerCheck(analyzedRoot);

    const reachedImports = new Set<UrlString>();

    // Inline all HTML Imports, using "reachedImports" for deduplication.
    await this._inlineHtmlImports(url, document, bundle, bundleManifest);

    if (this.enableScriptInlining) {
      await this._inlineScripts(url, document);
    }

    if (this.enableCssInlining) {
      await this._inlineStylesheetLinks(url, document);
      await this._inlineStylesheetImports(url, document);
    }

    if (this.stripComments) {
      this._stripComments(document);
    }
    return document;
  }

  /**
   * Creates a hidden container <div> to which inlined content will be
   * appended.
   */
  private _createHiddenDiv(): ASTNode {
    const hidden = dom5.constructors.element('div');
    dom5.setAttribute(hidden, 'hidden', '');
    dom5.setAttribute(hidden, 'by-polymer-bundler', '');
    return hidden;
  }

  /**
   * Given a document, search for the hidden div, if it isn't found, then
   * create it.  After creating it, attach it to the desired location.  Then
   * return it.
   */
  private _findOrCreateHiddenDiv(document: ASTNode): ASTNode {
    const hiddenDiv =
        dom5.query(document, matchers.hiddenDiv) || this._createHiddenDiv();
    if (!hiddenDiv.parentNode) {
      this._attachHiddenDiv(document, hiddenDiv);
    }
    return hiddenDiv;
  }

  private async _inlineHtmlImports(
      url: UrlString,
      document: ASTNode,
      bundle: AssignedBundle,
      bundleManifest: BundleManifest) {
    const reachedImports = new Set<UrlString>();
    const htmlImports = dom5.queryAll(document, matchers.htmlImport);
    for (const htmlImport of htmlImports) {
      await this.inlineHtmlImport(
          url, htmlImport, reachedImports, bundle, bundleManifest);
    }
  }

  /**
   * Replace all external javascript tags (`<script src="...">`)
   * with `<script>` tags containing the file contents inlined.
   */
  private async _inlineScripts(url: UrlString, document: ASTNode) {
    const scriptImports = dom5.queryAll(document, matchers.externalJavascript);
    for (const externalScript of scriptImports) {
      await this.inlineScript(url, externalScript);
    }
  }

  /**
   * Replace all polymer stylesheet imports (`<link rel="import" type="css">`)
   * with `<style>` tags containing the file contents, with internal URLs
   * relatively transposed as necessary.
   */
  private async _inlineStylesheetImports(url: UrlString, document: ASTNode) {
    const cssImports = dom5.queryAll(document, matchers.stylesheetImport);
    for (const cssLink of cssImports) {
      const style = await this.inlineStylesheet(url, cssLink);
      if (style) {
        this._moveDomModuleStyleIntoTemplate(style);
      }
    }
  }

  /**
   * Replace all external stylesheet references, in `<link rel="stylesheet">`
   * tags with `<style>` tags containing file contents, with internal URLs
   * relatively transposed as necessary.
   */
  private async _inlineStylesheetLinks(url: UrlString, document: ASTNode) {
    const cssLinks = dom5.queryAll(document, matchers.externalStyle);
    for (const cssLink of cssLinks) {
      await this.inlineStylesheet(url, cssLink);
    }
  }

  /**
   * Old Polymer supported `<style>` tag in `<dom-module>` but outside of
   * `<template>`.  This is also where the deprecated Polymer CSS import tag
   * `<link rel="import" type="css">` would generate inline `<style>`.
   * Migrates these `<style>` tags into available `<template>` of the
   * `<dom-module>`.  Will create a `<template>` container if not present.
   */
  private _moveDomModuleStyleIntoTemplate(style: ASTNode) {
    const domModule =
        dom5.nodeWalkAncestors(style, dom5.predicates.hasTagName('dom-module'));
    if (!domModule) {
      // TODO(usergenic): We *shouldn't* get here, but if we do, it's because
      // the analyzer messed up.
      return;
    }
    let template = dom5.query(domModule, matchers.template);
    if (!template) {
      template = dom5.constructors.element('template')!;
      dom5.append(domModule, template);
    }
    astUtils.removeElementAndNewline(style);
    astUtils.prepend(template, style);
  }
  /**
   * When an HTML Import is encountered in the head of the document, it needs
   * to be moved into the hidden div and any subsequent order-dependent
   * imperatives (imports, styles, scripts) must also be move into the
   * hidden div.
   */
  private _moveOrderedImperativesFromHeadIntoHiddenDiv(document: ASTNode) {
    const head = dom5.query(document, matchers.head);
    if (!head) {
      return;
    }
    const firstHtmlImport = dom5.query(head, matchers.htmlImport);
    if (!firstHtmlImport) {
      return;
    }
    for (const node of [firstHtmlImport].concat(
             astUtils.siblingsAfter(firstHtmlImport))) {
      if (matchers.orderedImperative(node)) {
        astUtils.removeElementAndNewline(node);
        dom5.append(this._findOrCreateHiddenDiv(document), node);
      }
    }
  }

  /**
   * Move any remaining htmlImports that are not inside the hidden div
   * already, into the hidden div.
   */
  private _moveUnhiddenHtmlImportsIntoHiddenDiv(document: ASTNode) {
    const unhiddenHtmlImports = dom5.queryAll(
        document,
        dom5.predicates.AND(
            matchers.htmlImport, dom5.predicates.NOT(matchers.inHiddenDiv)));
    for (const htmlImport of unhiddenHtmlImports) {
      astUtils.removeElementAndNewline(htmlImport);
      dom5.append(this._findOrCreateHiddenDiv(document), htmlImport);
    }
  }

  /**
   * Generate a fresh document (ASTNode) to bundle contents into.
   * If we're building a bundle which is based on an existing file, we
   * should load that file and prepare it as the bundle document, otherwise
   * we'll create a clean/empty html document.
   */
  private async _prepareBundleDocument(bundle: AssignedBundle):
      Promise<ASTNode> {
    const html = bundle.bundle.files.has(bundle.url) ?
        (await this.analyzer.analyze(bundle.url)).parsedDocument.contents :
        '';
    const document = parse5.parse(html);
    this._moveOrderedImperativesFromHeadIntoHiddenDiv(document);
    this._moveUnhiddenHtmlImportsIntoHiddenDiv(document);
    return document;
  }

  /**
   * Find all comment nodes in the document, removing them from the document
   * if they are note license comments, and if they are license comments,
   * deduplicate them and prepend them in document's head.
   */
  private _stripComments(document: ASTNode) {
    // Use of a Map keyed by comment text enables deduplication.
    const comments: Map<string, ASTNode> = new Map();
    dom5.nodeWalkAll(document, dom5.isCommentNode)
        .forEach((comment: ASTNode) => {
          comments.set(comment.data || '', comment);
          astUtils.removeElementAndNewline(comment);
        });
    const head = dom5.query(document, matchers.head);
    for (const comment of comments.values()) {
      if (astUtils.isLicenseComment(comment)) {
        astUtils.prepend(head || document, comment);
      }
    }
  }
}
