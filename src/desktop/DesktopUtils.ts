import path from "path"
import {spawn} from "child_process"
import type {Rectangle} from "electron"
import {NativeImage} from "electron"
import {base64ToBase64Url, defer, delay, noOp, uint8ArrayToBase64, uint8ArrayToHex} from "@tutao/tutanota-utils"
import {log} from "./DesktopLog"
import {fileExists, swapFilename} from "./PathUtils"
import {makeRegisterKeysScript, makeUnregisterKeysScript, RegistryRoot} from "./reg-templater"
import type {ElectronExports, FsExports} from "./ElectronExportTypes";
import {ProgrammingError} from "../api/common/error/ProgrammingError"
import {CryptoFunctions} from "./CryptoFns"
import {getResourcePath} from "./resources.js"

export class DesktopUtils {
	private readonly topLevelTempDir = "tutanota"
	/** we store all temporary files in a directory with a random name, so that the download location is not predictable */
	private readonly randomDirectoryName: string

	constructor(
		private readonly fs: FsExports,
		private readonly electron: ElectronExports,
		private readonly cryptoFunctions: CryptoFunctions,
	) {
		this.randomDirectoryName = base64ToBase64Url(uint8ArrayToBase64(cryptoFunctions.randomBytes(16)))
	}

	checkIsMailtoHandler(): Promise<boolean> {
		return Promise.resolve(this.electron.app.isDefaultProtocolClient("mailto"))
	}

	checkIsPerUserInstall(): Promise<boolean> {
		const markerPath = swapFilename(process.execPath, "per_user")
		return fileExists(markerPath)
	}

	/**
	 * open and close a file to make sure it exists
	 * @param path: the file to touch
	 */
	touch(path: string): void {
		this.fs.closeSync(this.fs.openSync(path, "a"))
	}

	async registerAsMailtoHandler(): Promise<void> {
		log.debug("trying to register mailto...")

		switch (process.platform) {
			case "win32":
				await this.doRegisterMailtoOnWin32WithCurrentUser()
				break
			case "darwin":
				const didRegister = this.electron.app.setAsDefaultProtocolClient("mailto")
				if (!didRegister) {
					throw new Error("Could not register as mailto handler")
				}
				break
			case "linux":
				throw new Error("Registering protocols on Linux does not work")
			default:
				throw new Error(`Invalid process.platform: ${process.platform}`)
		}
	}

	async unregisterAsMailtoHandler(): Promise<void> {
		log.debug("trying to unregister mailto...")
		switch (process.platform) {
			case "win32":
				await this.doUnregisterMailtoOnWin32WithCurrentUser()
				break
			case "darwin":
				const didUnregister = this.electron.app.removeAsDefaultProtocolClient("mailto")
				if (!didUnregister) {
					throw new Error("Could not unregister as mailto handler")
				}
				break
			case "linux":
				throw new Error("Registering protocols on Linux does not work")
			default:
				throw new Error(`Invalid process.platform: ${process.platform}`)
		}
	}

	/**
	 * reads the lockfile and then writes the own version into the lockfile
	 * @returns {Promise<boolean>} whether the lock was overridden by another version
	 */
	singleInstanceLockOverridden(): Promise<boolean> {
		const lockfilePath = this.getLockFilePath()
		return this.fs.promises
				   .readFile(lockfilePath, "utf8")
				   .then(version => {
					   return this.fs.promises.writeFile(lockfilePath, this.electron.app.getVersion(), "utf8").then(() => version !== this.electron.app.getVersion())
				   })
				   .catch(() => false)
	}

	/**
	 * checks that there's only one instance running while
	 * allowing different versions to steal the single instance lock
	 * from each other.
	 *
	 * should the lock file be unwritable/unreadable, behaves as if all
	 * running instances have the same version, effectively restoring the
	 * default single instance lock behaviour.
	 *
	 * @returns {Promise<boolean>} whether the app was successful in getting the lock
	 */
	makeSingleInstance(): Promise<boolean> {
		const lockfilePath = this.getLockFilePath()
		// first, put down a file in temp that contains our version.
		// will overwrite if it already exists.
		// errors are ignored and we fall back to a version agnostic single instance lock.
		return this.fs.promises
				   .writeFile(lockfilePath, this.electron.app.getVersion(), "utf8")
				   .catch(noOp)
				   .then(() => {
					   // try to get the lock, if there's already an instance running,
					   // give the other instance time to see if it wants to release the lock.
					   // if it changes the version back, it was a different version and
					   // will terminate itself.
					   return this.electron.app.requestSingleInstanceLock()
						   ? Promise.resolve(true)
						   : delay(1500)
							   .then(() => this.singleInstanceLockOverridden())
							   .then(canStay => {
								   if (canStay) {
									   this.electron.app.requestSingleInstanceLock()
								   } else {
									   this.electron.app.quit()
								   }

								   return canStay
							   })
				   })
	}

	/**
	 * this will silently fail if we're not admin.
	 * @param script: source of the registry script
	 * @private
	 */
	private async _executeRegistryScript(script: string): Promise<void> {
		const deferred = defer<void>()

		const file = await this._writeToDisk(script)

		spawn("reg.exe", ["import", file], {
			stdio: ["ignore", "inherit", "inherit"],
			detached: false,
		}).on("exit", (code, signal) => {
			this.fs.unlinkSync(file)

			if (code === 0) {
				deferred.resolve(undefined)
			} else {
				deferred.reject(new Error("couldn't execute registry script"))
			}
		})
		return deferred.promise
	}

	/**
	 * Writes contents with a random file name into the tmp directory
	 * @param contents
	 * @returns path to the written file
	 */
	private async _writeToDisk(contents: string): Promise<string> {
		const filename = uint8ArrayToHex(this.cryptoFunctions.randomBytes(12))
		const tmpPath = path.join(this.getTutanotaTempPath(), "reg")
		await this.fs.promises.mkdir(tmpPath, {recursive: true})
		const filePath = path.join(tmpPath, filename)

		await this.fs.promises.writeFile(filePath, contents, {
			encoding: "utf-8",
			mode: 0o400,
		})

		return filePath
	}

	async doRegisterMailtoOnWin32WithCurrentUser(): Promise<void> {
		if (process.platform !== "win32") {
			throw new ProgrammingError("Not win32")
		}
		// any app that wants to use tutanota over MAPI needs to know which dll to load.
		// additionally, the DLL needs to know
		// * which tutanota executable to start (per-user/per-machine/snapshot/test/release)
		// * where to log (this depends on the current user -> %USERPROFILE%)
		// * where to put tmp files (also user-dependent)
		// all these must be set in the registry
		const execPath = process.execPath
		const dllPath = swapFilename(execPath, "mapirs.dll")
		// we may be a per-machine installation that's used by multiple users, so the dll will replace %USERPROFILE%
		// with the value of the USERPROFILE env var.
		const appData = path.join("%USERPROFILE%", "AppData")
		const logPath = path.join(appData, "Roaming", this.electron.app.getName(), "logs")
		const tmpPath = path.join(appData, "Local", "Temp", this.topLevelTempDir, "attach")
		const tmpRegScript = makeRegisterKeysScript(RegistryRoot.CURRENT_USER, {execPath, dllPath, logPath, tmpPath})
		await this._executeRegistryScript(tmpRegScript)
		this.electron.app.setAsDefaultProtocolClient("mailto")
		await this._openDefaultAppsSettings()
	}

	async doUnregisterMailtoOnWin32WithCurrentUser(): Promise<void> {
		if (process.platform !== "win32") {
			throw new ProgrammingError("Not win32")
		}
		this.electron.app.removeAsDefaultProtocolClient('mailto')
		const tmpRegScript = makeUnregisterKeysScript(RegistryRoot.CURRENT_USER)
		await this._executeRegistryScript(tmpRegScript)
		await this._openDefaultAppsSettings()
	}

	private async _openDefaultAppsSettings(): Promise<void> {
		try {
			await this.electron.shell.openExternal("ms-settings:defaultapps")
		} catch (e) {
			// ignoring, this is just a convenience for the user
			console.error("failed to open default apps settings page:", e.message)
		}
	}

	/**
	 * Get a path to the tutanota temporary directory
	 * the hierarchy is
	 * [electron tmp dir]
	 * [tutanota tmp]
	 *
	 * the directory will be created if it doesn't already exist
	 *
	 * a randomly named subdirectory will be included
	 *
	 * if `noRandomDirectory` then random directory will not be included in the path,
	 * and the whole directory will not be created
	 * @returns {string}
	 */
	getTutanotaTempPath(): string {
		const directory = path.join(this.electron.app.getPath("temp"), this.topLevelTempDir, this.randomDirectoryName)

		// only readable by owner (current user)
		this.fs.mkdirSync(directory, {recursive: true, mode: 0o700})

		return path.join(directory)
	}

	deleteTutanotaTempDir() {
		const topLvlTmpDir = path.join(this.electron.app.getPath("temp"), this.topLevelTempDir)
		try {
			const tmps = this.fs.readdirSync(topLvlTmpDir)
			for (const tmp of tmps) {
				const tmpSubPath = path.join(topLvlTmpDir, tmp)
				try {
					this.fs.rmSync(tmpSubPath, {recursive: true})
				} catch (e) {
					// ignore if the file was deleted between readdir and delete
					// or if it's not our tmp dir
					if (e.code !== "ENOENT" && e.code !== "EACCES") throw e
				}
			}
		} catch (e) {
			// the tmp dir doesn't exist, everything's fine
			if (e.code !== "ENOENT") throw e
		}
	}

	getLockFilePath() {
		// don't get temp dir path from DesktopDownloadManager because the path returned from there may be deleted at some point,
		// we want to put the lockfile in root tmp so it persists
		return path.join(this.electron.app.getPath("temp"), "tutanota_desktop_lockfile")
	}

	getIconByName(iconName: string): NativeImage {
		const iconPath = getResourcePath(`icons/${iconName}`)
		return this.electron.nativeImage.createFromPath(iconPath)
	}

}

export function isRectContainedInRect(closestRect: Rectangle, lastBounds: Rectangle): boolean {
	return (
		lastBounds.x >= closestRect.x - 10 &&
		lastBounds.y >= closestRect.y - 10 &&
		lastBounds.width + lastBounds.x <= closestRect.width + 10 &&
		lastBounds.height + lastBounds.y <= closestRect.height + 10
	)
}