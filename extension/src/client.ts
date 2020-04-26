import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import * as grpc from '@grpc/grpc-js';

import {
  Progress,
  RunTaskRequest,
  RunTaskReply,
  Output,
  GetBuildRequest,
  GetBuildReply,
  CancelGetBuildsRequest,
  CancelGetBuildsReply,
  CancelRunTaskRequest,
  CancelRunTaskReply,
  CancelRunTasksReply,
  Cancelled,
  GradleBuild,
  CancelRunTasksRequest,
} from './proto/gradle_tasks_pb';

import { GradleTasksClient as GrpcClient } from './proto/gradle_tasks_grpc_pb';
import { GradleTasksServer } from './server';
import { logger } from './logger';
import { handleCancelledTask } from './tasks';

const localize = nls.loadMessageBundle();

export class GradleTasksClient implements vscode.Disposable {
  private connectDeadline = 3; // seconds
  private grpcClient: GrpcClient | null = null;
  private _onConnect: vscode.EventEmitter<null> = new vscode.EventEmitter<
    null
  >();
  public readonly onConnect: vscode.Event<null> = this._onConnect.event;
  private connectTries = 0;
  private maxConnectTries = 5;

  public constructor(
    private readonly server: GradleTasksServer,
    private readonly statusBarItem: vscode.StatusBarItem
  ) {
    this.server.onReady(this.handleServerReady);
    this.server.onStop(this.handleServerStop);
    this.server.start();
  }

  private handleServerStop = (): void => {
    //
  };

  public handleServerReady = (): void => {
    // TODO
    this.statusBarItem.text = '$(sync~spin) Gradle: Connecting';
    this.statusBarItem.show();
    // TODO
    logger.debug(
      localize('client.connecting', 'Gradle client connecting to server')
    );
    this.connectToServer();
  };

  public handleClientReady = (err: Error | undefined): void => {
    if (err) {
      this.handleConnectError(err);
    } else {
      logger.info(
        localize('client.connected', 'Gradle client connected to server')
      );
      this._onConnect.fire();
    }
  };

  private connectToServer(): void {
    try {
      this.grpcClient = new GrpcClient(
        `localhost:${this.server.getPort()}`,
        grpc.credentials.createInsecure()
      );
      const deadline = new Date();
      deadline.setSeconds(deadline.getSeconds() + this.connectDeadline);
      this.grpcClient.waitForReady(deadline, this.handleClientReady);
    } catch (err) {
      logger.error(
        localize(
          'client.grpcClientConstructionError',
          'Unable to construct the gRPC client: {0}',
          err.message
        )
      );
      this.statusBarItem.hide();
    }
  }

  public async getBuild(projectFolder: string): Promise<GradleBuild | void> {
    this.statusBarItem.text = localize(
      'client.refreshingTasks',
      '{0} Gradle: Refreshing Tasks',
      '$(sync~spin)'
    );
    this.statusBarItem.show();
    const request = new GetBuildRequest();
    request.setProjectDir(projectFolder);
    const getBuildStream = this.grpcClient!.getBuild(request);
    try {
      return await new Promise((resolve, reject) => {
        let build: GradleBuild | void = undefined;
        getBuildStream
          .on('data', (getBuildReply: GetBuildReply) => {
            switch (getBuildReply.getKindCase()) {
              case GetBuildReply.KindCase.PROGRESS:
                this.handleProgress(getBuildReply.getProgress()!);
                break;
              case GetBuildReply.KindCase.OUTPUT:
                this.handleOutput(getBuildReply.getOutput()!);
                break;
              case GetBuildReply.KindCase.CANCELLED:
                this.handleGetBuildCancelled(getBuildReply.getCancelled()!);
                break;
              case GetBuildReply.KindCase.GET_BUILD_RESULT:
                build = getBuildReply.getGetBuildResult()!.getBuild();
                break;
            }
          })
          .on('error', reject)
          .on('end', () => {
            resolve(build);
          });
      });
    } catch (err) {
      logger.error(
        localize(
          'client.errorGettingBuild',
          'Error getting build for {0}: {1}',
          projectFolder,
          err.details || err.message
        )
      );
    } finally {
      this.statusBarItem.hide();
    }
  }

  public async runTask(
    projectFolder: string,
    task: vscode.Task,
    args: string[] = [],
    javaDebugPort: number | null,
    onOutput: (output: Output) => void
  ): Promise<void> {
    this.statusBarItem.show();
    const request = new RunTaskRequest();
    request.setProjectDir(projectFolder);
    request.setTask(task.definition.script);
    request.setJavaDebug(task.definition.javaDebug);
    if (javaDebugPort !== null) {
      request.setJavaDebugPort(javaDebugPort);
    }
    request.setArgsList(args);
    const runTaskStream = this.grpcClient!.runTask(request);
    try {
      await new Promise((resolve, reject) => {
        runTaskStream
          .on('data', (runTaskReply: RunTaskReply) => {
            switch (runTaskReply.getKindCase()) {
              case RunTaskReply.KindCase.PROGRESS:
                this.handleProgress(runTaskReply.getProgress()!);
                break;
              case RunTaskReply.KindCase.OUTPUT:
                onOutput(runTaskReply.getOutput()!);
                break;
              case RunTaskReply.KindCase.CANCELLED:
                this.handleRunTaskCancelled(runTaskReply.getCancelled()!);
                break;
            }
          })
          .on('error', reject)
          .on('end', () => {
            resolve();
          });
      });
      logger.info(
        localize(
          'client.completedTask',
          'Completed task {0}',
          task.definition.script
        )
      );
    } catch (err) {
      logger.error(
        // TODO
        localize(
          'client.errorRunningTask',
          'Error running task: {0}',
          err.details || err.message
        )
      );
    } finally {
      this.statusBarItem.hide();
    }
  }

  public async cancelRunTask(
    projectFolder: string,
    task: string
  ): Promise<void> {
    const request = new CancelRunTaskRequest();
    request.setProjectDir(projectFolder);
    request.setTask(task);
    try {
      const cancelRunTaskReply: CancelRunTaskReply = await new Promise(
        (resolve, reject) => {
          this.grpcClient!.cancelRunTask(
            request,
            (
              err: grpc.ServiceError | null,
              cancelRunTaskReply: CancelRunTaskReply | undefined
            ) => {
              if (err) {
                reject(err);
              } else {
                resolve(cancelRunTaskReply);
              }
            }
          );
        }
      );
      logger.debug(cancelRunTaskReply.getMessage());
      if (!cancelRunTaskReply.getTaskRunning()) {
        handleCancelledTask(task, projectFolder);
      }
    } catch (err) {
      logger.error(
        localize(
          'client.errorCancellingRunningTask',
          'Error cancelling running task: {0}',
          err.details || err.message
        )
      );
    }
  }

  public async cancelRunTasks(): Promise<void> {
    const request = new CancelRunTasksRequest();
    try {
      const cancelRunTasksReply: CancelRunTasksReply = await new Promise(
        (resolve, reject) => {
          this.grpcClient!.cancelRunTasks(
            request,
            (
              err: grpc.ServiceError | null,
              cancelRunTasksReply: CancelRunTasksReply | undefined
            ) => {
              if (err) {
                reject(err);
              } else {
                resolve(cancelRunTasksReply);
              }
            }
          );
        }
      );
      logger.debug(cancelRunTasksReply.getMessage());
    } catch (err) {
      logger.error(
        localize(
          'client.errorCancellingRunningTasks',
          'Error cancelling running tasks: {0}',
          err.details || err.message
        )
      );
    }
  }

  public async cancelGetBuilds(): Promise<void> {
    const request = new CancelGetBuildsRequest();
    try {
      const cancelGetBuildsReply: CancelGetBuildsReply = await new Promise(
        (resolve, reject) => {
          this.grpcClient!.cancelGetBuilds(
            request,
            (
              err: grpc.ServiceError | null,
              cancelGetBuildsReply: CancelGetBuildsReply | undefined
            ) => {
              if (err) {
                reject(err);
              } else {
                resolve(cancelGetBuildsReply);
              }
            }
          );
        }
      );
      logger.debug(cancelGetBuildsReply.getMessage());
    } catch (err) {
      logger.error(
        localize(
          'client.errorCancellingGetBuilds',
          'Error cancelling get builds: {0}',
          err.details || err.message
        )
      );
    }
  }

  private handleRunTaskCancelled = (cancelled: Cancelled): void => {
    logger.info(
      localize(
        'client.runTaskCancelled',
        'Task cancelled: {0}',
        cancelled.getMessage()
      )
    );
    handleCancelledTask(cancelled.getTask(), cancelled.getProjectDir());
  };

  private handleGetBuildCancelled = (cancelled: Cancelled): void => {
    logger.info(
      localize(
        'client.getBuildCancelled',
        'Get build cancelled: {0}',
        cancelled.getMessage()
      )
    );
  };

  private handleProgress = (progress: Progress): void => {
    const messageStr = progress.getMessage().trim();
    if (messageStr) {
      this.statusBarItem.text = `$(sync~spin) Gradle: ${messageStr}`;
    }
  };

  private handleOutput = (output: Output): void => {
    const logMessage = output.getMessage().trim();
    if (logMessage) {
      switch (output.getOutputType()) {
        case Output.OutputType.STDERR:
          logger.error(logMessage);
          break;
        case Output.OutputType.STDOUT:
          logger.info(logMessage);
          break;
      }
    }
  };

  private handleConnectError = (e: Error): void => {
    // Even though the gRPC client should keep retrying to connect, in some cases
    // that doesn't work as expected (like CI tests in Windows), which is why we
    // have to manually keep retrying.
    if (this.connectTries < this.maxConnectTries) {
      this.connectTries += 1;
      this.grpcClient?.close();
      this.connectToServer();
    } else {
      logger.error(
        localize(
          'client.errorConnectingToServer',
          'Error connecting to gradle server: {0}',
          e.message
        )
      );
      this.server.showRestartMessage();
    }
  };

  public dispose(): void {
    this.grpcClient?.close();
    this._onConnect.dispose();
  }
}

export function registerClient(
  server: GradleTasksServer,
  statusBarItem: vscode.StatusBarItem,
  context: vscode.ExtensionContext
): GradleTasksClient {
  const client = new GradleTasksClient(server, statusBarItem);
  context.subscriptions.push(client);
  client.onConnect(() => {
    vscode.commands.executeCommand('gradle.refresh', false);
  });
  return client;
}
