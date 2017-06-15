/** @flow */
import path from 'path';
import glob from 'glob';
import fs from 'fs-extra';
import R from 'ramda';
import chalk from 'chalk';
import VersionDependencies from '../scope/version-dependencies';
import { flattenDependencies } from '../scope/flatten-dependencies';
import { locateConsumer, pathHasConsumer } from './consumer-locator';
import {
  ConsumerAlreadyExists,
  ConsumerNotFound,
  NothingToImport,
} from './exceptions';
import { Driver } from '../driver';
import DriverNotFound from '../driver/exceptions/driver-not-found';
import ConsumerBitJson from './bit-json/consumer-bit-json';
import { BitId, BitIds } from '../bit-id';
import Component from './component';
import {
  INLINE_BITS_DIRNAME,
  BITS_DIRNAME,
  BIT_HIDDEN_DIR,
 } from '../constants';
import { removeContainingDirIfEmpty } from '../utils';
import { Scope, ComponentDependencies } from '../scope';
import BitInlineId from './bit-inline-id';
import loader from '../cli/loader';
import { BEFORE_IMPORT_ACTION } from '../cli/loader/loader-messages';
import { index } from '../search/indexer';
import BitLock from './bit-lock/bit-lock';
import logger from '../logger/logger';
import DirStructure from './dir-structure/dir-structure';

export type ConsumerProps = {
  projectPath: string,
  created?: boolean,
  bitJson: ConsumerBitJson,
  scope: Scope
};

export default class Consumer {
  projectPath: string;
  created: boolean;
  bitJson: ConsumerBitJson;
  scope: Scope;
  _driver: Driver;
  _bitLock: BitLock;
  _dirStructure: DirStructure;

  constructor({ projectPath, bitJson, scope, created = false }: ConsumerProps) {
    this.projectPath = projectPath;
    this.bitJson = bitJson;
    this.created = created;
    this.scope = scope;
    this.warnForMissingDriver();
  }

  get testerId(): ?BitId {
    return BitId.parse(this.bitJson.testerId, this.scope);
  }

  get compilerId(): ?BitId {
    return BitId.parse(this.bitJson.compilerId, this.scope);
  }

  get driver(): Driver {
    if (!this._driver) {
      this._driver = Driver.load(this.bitJson.lang);
    }
    return this._driver;
  }

  get dirStructure(): DirStructure {
    if (!this._dirStructure) {
      this._dirStructure = new DirStructure(this.bitJson.structure);
    }
    return this._dirStructure;
  }

  get bitLock(): BitLock {
    if (!this._bitLock) {
      this._bitLock = BitLock.load(this.getPath());
    }
    return this._bitLock;
  }

  warnForMissingDriver() {
    try {
      this.driver.getDriver(false);
    } catch (err) {
      if (err instanceof DriverNotFound) {
        console.log(chalk.yellow(`Warning: Bit is not be able to run the bind command. Please install bit-${err.lang} driver and run the bind command.`)); // eslint-disable-line
      }
    }
  }

  write(): Promise<Consumer> {
    return this.bitJson
      .write({ bitDir: this.projectPath })
      .then(() => this.scope.ensureDir())
      .then(() => this);
  }

  getInlineBitsPath(): string {
    return path.join(this.projectPath, INLINE_BITS_DIRNAME);
  }

  getComponentsPath(): string {
    return path.join(this.projectPath, BITS_DIRNAME);
  }

  getPath(): string {
    return this.projectPath;
  }

  getBitPathInComponentsDir(id: BitId): string {
    return path.join(this.getComponentsPath(), id.toPath());
  }

  loadComponent(id: BitInlineId): Promise<Component> {
    const bitDir = this.bitLock.getComponentPath(id) || this.composeBitPath(id);
    return Component.loadFromInline(bitDir, this.bitJson);
  }

  exportAction(rawId: string, rawRemote: string) {
    // @TODO - move this method to api, not related to consumer
    const bitId = BitId.parse(rawId);

    return this.scope.exportAction(bitId, rawRemote)
      .then(componentDependencies => componentDependencies.component);
  }


  import(rawIds: ?string[], verbose?: bool, withEnvironments: ?bool, cache?: bool = true):
  Promise<{ dependencies: ComponentDependencies[], envDependencies?: Component[] }> {
    const importAccordingToConsumerBitJson = () => {
      const dependencies = BitIds.fromObject(this.bitJson.dependencies);
      if (R.isNil(dependencies) || R.isEmpty(dependencies)) {
        if (!withEnvironments) {
          return Promise.reject(new NothingToImport());
        } else if (R.isNil(this.testerId) || R.isNil(this.compilerId)) {
          return Promise.reject(new NothingToImport());
        }
      }

      return this.scope.getMany(dependencies, cache)
        .then((componentDependenciesArr) => {
          return this.writeToComponentsDir(componentDependenciesArr)
          .then(() => {
            return withEnvironments ?
            this.scope.installEnvironment({
              ids: [this.testerId, this.compilerId],
              consumer: this,
              verbose
            })
            .then(envComponents => ({
              dependencies: componentDependenciesArr,
              envDependencies: envComponents,
            })) : { dependencies: componentDependenciesArr };
          });
        });
    };

    const importSpecificComponents = () => {
      // $FlowFixMe - we check if there are bitIds before we call this function
      const bitIds = rawIds.map(raw => BitId.parse(raw, this.scope.name));
      return this.scope.getMany(bitIds, cache)
      .then((componentDependenciesArr) => {
        return this.writeToComponentsDir(componentDependenciesArr)
          .then(() => ({ dependencies: componentDependenciesArr }));
      });
    };

    loader.start(BEFORE_IMPORT_ACTION);
    if (!rawIds || R.isEmpty(rawIds)) return importAccordingToConsumerBitJson();
    return importSpecificComponents();
  }

  importEnvironment(rawId: ?string, verbose?: bool) {
    if (!rawId) { throw new Error('you must specify bit id for importing'); } // @TODO - make a normal error message
    const bitId = BitId.parse(rawId, this.scope.name);
    return this.scope.installEnvironment({ ids: [bitId], consumer: this, verbose });
  }

  addComponent(componentPath: string, id: string) {
    try {
      const parsedId = BitId.parse(id);
      this.bitLock.addComponent(parsedId.toString(), componentPath);
      this.bitLock.write();
      return Promise.resolve({ added: parsedId.toString() });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Creates a new component, writes it to the file system and adds to bit.lock
   */
  createComponent({ id, withSpecs = false, withBitJson = false, force = false }: {
    id: BitId, withSpecs: boolean, withBitJson: boolean, force: boolean
  }): Promise<Component> {
    const bitPath = this.composeBitPath(id);

    return Component.create({
      name: id.name,
      box: id.box,
      withSpecs,
      consumerBitJson: this.bitJson,
    }, this.scope)
      .write(bitPath, withBitJson, force)
      .then((component) => {
        this.bitLock.addComponent(id.toString(), this.composeRelativeBitPath(id));
        this.bitLock.write();
        return this.driver.runHook('onCreate', component, component);
      });
  }

  removeFromComponents(id: BitId, currentVersionOnly: boolean = false): Promise<any> {
    const componentsDir = this.getComponentsPath();
    const componentDir = path.join(
      componentsDir,
      id.box,
      id.name,
      id.scope,
      currentVersionOnly ? id.version : ''
    );

    return new Promise((resolve, reject) => {
      return fs.remove(componentDir, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });
  }

  writeToComponentsDir(componentDependencies: VersionDependencies[]): Promise<Component[]> {
    const components = flattenDependencies(componentDependencies);

    return Promise.all(components.map((component) => {
      const bitPath = this.composeBitPath(component.id);
      return component.write(bitPath, true);
    }));
  }

  commit(id: BitInlineId, message: string, force: ?bool, verbose: ?bool) {
    const bitDir = this.bitLock.getComponentPath(id);
    if (!bitDir) throw new Error(`Unable to find a component ${id} in your bit.lock file. Consider "bit add" it`);
    const implFile = this.bitLock.getComponentImplFile(id);

    return this.loadComponent(id)
      .then((bit) => {
        if (implFile) {
          bit.implFile = implFile;
          bit.impl = path.join(bitDir, implFile);
        }
        return this.scope.put({ consumerComponent: bit, message, force, consumer: this, bitDir, verbose })
          .then(() => index(bit, this.scope.getPath())) // todo: make sure it still works
          .then(() => this.driver.runHook('onCommit', bit)) // todo: probably not needed as the bind happens on create
          .then(() => bit);
      });
  }

  composeRelativeBitPath(bitId: BitId): string {
    const { staticParts, dynamicParts } = this.dirStructure.componentsDirStructure;
    const dynamicDirs = dynamicParts.map(part => bitId[part]);
    const addToPath = [...staticParts, ...dynamicDirs];
    return path.join(...addToPath);
  }

  composeBitPath(bitId: BitId): string {
    const addToPath = [this.getPath(), this.composeRelativeBitPath(bitId)];
    logger.debug(`component dir path: ${addToPath.join('/')}`);
    return path.join(...addToPath);
  }

  runComponentSpecs(id: BitInlineId, verbose: boolean = false): Promise<?any> {
    return this.loadComponent(id)
      .then((component) => {
        return component.runSpecs({ scope: this.scope, consumer: this, verbose });
      });
  }

  runAllInlineSpecs(verbose: boolean = false) {
    return this.listInline().then((components) => {
      return Promise.all(components.map(component => component
        .runSpecs({ scope: this.scope, consumer: this, verbose })
        .then((result) => { return { specs: result, component }; })));
    });
  }

  listInline(): Promise<Component[]> {
    return new Promise((resolve, reject) =>
      glob(path.join('*', '*'), { cwd: this.getInlineBitsPath() }, (err, files) => {
        if (err) reject(err);

        const bitsP = files.map((bitRawId) => {
          const parsedId = BitInlineId.parse(bitRawId);
          return this.loadComponent(parsedId);
        });

        return Promise.all(bitsP)
        .then(resolve)
        .catch(reject);
      })
    );
  }

  /**
   * Finds all components that are saved in the file system.
   * Components might be stored in the default component directory and also might be outside
   * of that directory, in which case the bit.lock is used to find them
   * @return {Promise<Component[]>}
   */
  listFromFileSystem(): Promise<Component[]> {
    const idsFromBitLock = Object.keys(this.listFromBitLock());
    const componentsP = idsFromBitLock.map((id) => {
      const parsedId = BitId.parse(id);
      return this.loadComponent(parsedId);
    });

    const { staticParts, dynamicParts } = this.dirStructure.componentsDirStructure;
    const asterisks = Array(dynamicParts.length).fill('*'); // e.g. ['*', '*', '*']
    const cwd = path.join(this.getPath(), ...staticParts);
    return new Promise((resolve, reject) =>
      glob(path.join(...asterisks), { cwd }, (err, files) => {
        if (err) reject(err);

        files.forEach((componentDynamicDirStr) => {
          const componentDynamicDir = componentDynamicDirStr.split(path.sep);
          const bitIdObj = {};
          // combine componentDynamicDir (e.g. ['array', 'sort]) and dynamicParts
          // (e.g. ['namespace', 'name']) into one object.
          // (e.g. { namespace: 'array', name: 'sort' } )
          componentDynamicDir.forEach((dir, idx) => {
            const key = dynamicParts[idx];
            bitIdObj[key] = dir;
          });
          // todo: a component might be originated from a remote, load the objects to check
          const parsedId = new BitId(bitIdObj);
          if (!idsFromBitLock.includes(parsedId.toString())) {
            componentsP.push(this.loadComponent(parsedId));
          }
        });

        return Promise.all(componentsP)
          .then(resolve)
          .catch(reject);
      })
    );
  }

  listFromBitLock(): Object {
    const bitLock = BitLock.load(this.getPath());
    return bitLock.getAllComponents();
  }

  includes({ inline, bitName }: { inline: ?boolean, bitName: string }): Promise<boolean> {
    const dirToCheck = inline ? this.getInlineBitsPath() : this.getComponentsPath();

    return new Promise((resolve) => {
      return fs.stat(path.join(dirToCheck, bitName), (err) => {
        if (err) return resolve(false);
        return resolve(true);
      });
    });
  }

  static create(projectPath: string = process.cwd()): Promise<Consumer> {
    if (pathHasConsumer(projectPath)) return Promise.reject(new ConsumerAlreadyExists());
    return this.ensure(projectPath);
  }

  static ensure(projectPath: string = process.cwd()): Promise<Consumer> {
    const scopeP = Scope.ensure(path.join(projectPath, BIT_HIDDEN_DIR));
    const bitJsonP = ConsumerBitJson.ensure(projectPath);

    return Promise.all([scopeP, bitJsonP])
    .then(([scope, bitJson]) => {
      return new Consumer({
        projectPath,
        created: true,
        scope,
        bitJson
      });
    });
  }

  static load(currentPath: string): Promise<Consumer> {
    return new Promise((resolve, reject) => {
      const projectPath = locateConsumer(currentPath);
      if (!projectPath) return reject(new ConsumerNotFound());
      const scopeP = Scope.load(path.join(projectPath, BIT_HIDDEN_DIR));
      const bitJsonP = ConsumerBitJson.load(projectPath);
      return Promise.all([scopeP, bitJsonP])
      .then(([scope, bitJson]) =>
        resolve(
          new Consumer({
            projectPath,
            bitJson,
            scope
          })
        )
      );
    });
  }
}
