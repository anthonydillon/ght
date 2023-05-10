import { JobInfo, PostInfo } from "./common/types";
import { regionCategories, regions } from "./common/regions";
import Job from "./automations/Job";
import SSO from "./automations/SSO";
import { PROTECTED_JOB_BOARDS } from "./common/constants";
import { displayError, setupSentry } from "./common/processUtils";
import UserError from "./common/UserError";
import { runPrompt } from "./common/commandUtils";
import { tests } from "./test-greenhouse";
import assignGraders from "./assign-graders";
import { Command, Argument, Option } from "commander";
import { green } from "colors";
import ora, { Ora } from "ora";
// @ts-ignore This can be deleted after https://github.com/enquirer/enquirer/issues/135 is fixed.
import { Select, MultiSelect, Toggle } from "enquirer";
import { Page } from "puppeteer";

async function getJobInteractive(job: Job, message: string, spinner: Ora) {
    spinner.start("Fetching your jobs.");
    const jobs = await job.getJobs();
    spinner.succeed();

    if (jobs.size === 0)
        throw new UserError(
            "Only hiring leads can create job posts. If you are not sure about your hiring role please contact HR."
        );

    const prompt = new Select({
        name: "Job",
        message,
        choices: [...jobs.keys()],
    });

    const jobName = await runPrompt(prompt);
    return {
        name: jobName,
        id: jobs.get(jobName),
    };
}

async function getJobPostInteractive(posts: PostInfo[], message: string) {
    // Only job posts in the "Canonical" board should be displayed
    const board = PROTECTED_JOB_BOARDS[0].toUpperCase();
    const uniqueNames = new Set(
        posts
            .filter((post) => post.boardInfo.name.toUpperCase() === board)
            .map((post) => post.name)
    );

    if (!uniqueNames.size)
        throw new Error(`No job post found in the Canonical board.`);

    const prompt = new Select({
        name: "Job Post",
        message,
        choices: [...uniqueNames],
    });
    const jobPostName = await runPrompt(prompt);
    // Get one of job posts whose name matches with the chosen name. It doesn not matter which one.
    const matchedJobPost = posts.find(
        (post) =>
            post.name === jobPostName &&
            post.boardInfo.name.toUpperCase() === board
    );
    if (!matchedJobPost)
        throw new Error(
            `No job post found with name ${jobPostName} in the ${board} board.`
        );

    return matchedJobPost.id;
}

async function getRegionsInteractive(message: string) {
    const regionNames = regionCategories;
    const prompt = new MultiSelect({
        name: "Regions",
        message,
        choices: regionNames,
        validate: (value: string[]) => value.length > 0,
    });
    const region = await runPrompt(prompt);
    return region;
}

async function deletePostsInteractive(
    job: Job,
    jobInfo: JobInfo,
    regionNames: string[],
    similar: number
) {
    const prompt = new Toggle({
        message: "Do you want to remove existing job posts?",
        enabled: "Yes",
        disabled: "No",
        initial: true,
    });

    const shouldDelete = await runPrompt(prompt);
    if (shouldDelete) {
        await job.deletePosts(jobInfo, regionNames, similar);
    }
}

export async function provideAuthentication(
    sso: SSO,
    action: (page: Page) => Promise<void>
) {
    const { browser, page } = await sso.authenticate();
    try {
        await action(page);
        browser.close();
    } catch (e) {
        browser.close();
        throw e;
    }
}
export async function addPosts(
    spinner: Ora,
    isInteractive: boolean,
    postIDArg: number,
    regionsArg: string[],
    page: Page
) {
    const job = new Job(page, spinner);
    let jobID;
    let jobInfo: JobInfo;
    let regionNames = regionsArg;
    let cloneFrom;

    if (isInteractive) {
        const { name, id } = await getJobInteractive(
            job,
            "What job would you like to create job posts for?",
            spinner
        );
        if (!id) throw new Error(`Job cannot be found with id ${id}.`);
        jobID = id;
        spinner.start(`Fetching job posts for ${name}.`);
        jobInfo = await job.getJobData(jobID);
        if (!jobInfo.posts.length)
            throw new Error(`Job posts cannot be found for ${jobInfo.name}.`);
        spinner.succeed();

        const jobPostID = await getJobPostInteractive(
            jobInfo.posts,
            "What job post should be copied?"
        );
        cloneFrom = jobPostID;

        regionNames = await getRegionsInteractive(
            "What region should those job posts be? Use space to make a selection."
        );

        await deletePostsInteractive(job, jobInfo, regionNames, cloneFrom);
    } else {
        if (!postIDArg) throw new UserError(`Job post ID argument is missing.`);
        if (!regionNames) throw new UserError(`Region parameter is missing.`);
        cloneFrom = postIDArg;

        spinner.start(`Fetching the job information.`);
        jobID = await job.getJobIDFromPost(postIDArg);
        jobInfo = await job.getJobData(jobID);
        if (!jobInfo.posts.length)
            throw new Error(`Job posts cannot be found for ${jobInfo.name}.`);
        spinner.succeed();
    }
    // Process updates for each 'Canonical' job unless a "clone-from" argument is passed
    const clonedJobPosts = await job.clonePost(
        jobInfo.posts,
        regionNames,
        cloneFrom
    );
    // Mark all newly added job posts as live
    const processedJobCount = await job.markAsLive(jobID, jobInfo.posts);

    console.log(
        green("✔"),
        `${processedJobCount} job posts for ${clonedJobPosts
            .map((post) => post.name)
            .join(", ")} of ${jobInfo.name} were created in ${regionNames}`
    );
    console.log("Happy hiring!");
}

export async function deletePosts(
    spinner: Ora,
    isInteractive: boolean,
    jobPostIDArg: number,
    regionsArg: string[],
    page: Page
) {
    const job = new Job(page, spinner);
    let jobID;
    let jobInfo: JobInfo;
    let regionNames = regionsArg;
    let postID = jobPostIDArg;

    if (isInteractive) {
        const { name, id } = await getJobInteractive(
            job,
            "What job would you like to delete job posts from?",
            spinner
        );

        if (!id) throw new Error(`Job with ${id} cannot be found.`);
        jobID = id;

        spinner.start(`Fetching job posts for ${name}.`);
        jobInfo = await job.getJobData(jobID);
        if (!jobInfo.posts.length)
            throw new Error(`Job posts cannot be found for ${jobInfo.name}.`);
        spinner.succeed();

        const jobPostID = await getJobPostInteractive(
            jobInfo.posts,
            "Which job posts should be deleted?"
        );
        postID = jobPostID;

        regionNames = await getRegionsInteractive(
            "What region should the job posts be deleted from? Use space to make a selection."
        );
    } else {
        spinner.start(`Fetching the job information.`);
        jobID = await job.getJobIDFromPost(postID);
        jobInfo = await job.getJobData(jobID);
        spinner.succeed();
    }
    await job.deletePosts(jobInfo, regionNames, postID);
    console.log("Happy hiring!");
}

function validateNumberParam(param: string, fieldName: string) {
    const intValue = parseInt(param);
    if (isNaN(intValue)) throw new UserError(`${fieldName} must be a number`);
    return intValue;
}

function validateRegionParam(param: string) {
    const enteredRegions: string[] = [
        ...new Set(param.split(",").map((value) => value.trim())),
    ];

    enteredRegions.forEach((enteredRegion) => {
        if (!regions[enteredRegion])
            throw new UserError(
                `Invalid region, available regions are: americas, apac, emea, canada, latam.`
            );
    });

    return enteredRegions;
}

function configureReplicateCommand(command: Command, sso: SSO, spinner: Ora) {
    return command
        .command("replicate")
        .usage(
            "([-i | --interactive] | <job-post-id> --regions=<region-name>[, <region-name-2>...])" +
                "\n\n Examples: \n\t ght replicate --interactive " +
                "\n \t ght replicate 1234 --regions=emea,americas"
        )
        .description(
            "Create job post for a specific job in the specified regions from all existing " +
                "job posts in the Canonical Board"
        )
        .addArgument(
            new Argument(
                "<job-post-id>",
                "ID of a job post that will be cloned from"
            )
                .argOptional()
                .argParser((value: string) =>
                    validateNumberParam(value, "job post id")
                )
        )
        .addOption(
            new Option(
                "-r, --regions <region-name>",
                "Add job posts to given region/s"
            ).argParser(validateRegionParam)
        )
        .addOption(
            new Option("-i, --interactive", "Enable interactive interface")
        )
        .action(async (jobPostID, options) => {
            await provideAuthentication(sso, (page) =>
                addPosts(
                    spinner,
                    options.interactive,
                    jobPostID,
                    options.regions,
                    page
                )
            );
        });
}

function configureResetCommand(command: Command, sso: SSO, spinner: Ora) {
    return command
        .command("reset")
        .usage(
            "([-i | --interactive] | <job-post-id> --regions=<region-name>[, <region-name-2>...])" +
                " \n\n Examples: \n\t ght reset --interactive " +
                "\n\t ght reset 1234 --regions=emea,americas"
        )
        .description("Delete job posts of the given job")
        .addArgument(
            new Argument(
                "<job-post-id>",
                "Delete job posts that have same name with the given post"
            )
                .argOptional()
                .argParser((value: string) =>
                    validateNumberParam(value, "job-post-id")
                )
        )
        .addOption(
            new Option(
                "-r, --regions <region-name>",
                "Delete job posts that are in the given region"
            ).argParser(validateRegionParam)
        )
        .addOption(
            new Option("-i, --interactive", "Enable interactive interface")
        )
        .action(async (jobPostID, options) => {
            await provideAuthentication(sso, (page) =>
                deletePosts(
                    spinner,
                    options.interactive,
                    jobPostID,
                    options.regions,
                    page
                )
            );
        });
}

function configureLoginCommand(command: Command, sso: SSO) {
    return command
        .command("login")
        .description("Login and save credentials")
        .action(async () => {
            await sso.login();
        });
}

function configureLogoutCommand(command: Command, sso: SSO) {
    return command
        .command("logout")
        .description("Remove saved credentials")
        .action(() => {
            sso.logout();
        });
}

function configureLoadBalancerCommand(
    command: Command,
    sso: SSO,
    spinner: Ora
) {
    return command
        .command("assign")
        .usage(
            "([-i | --interactive])" +
                "\n\n Examples: \n\t ght assign --interactive"
        )
        .description(
            "Assign graders to written interviews for the jobs selected.\n" +
                "Graders are randomly picked from a ght-graders.yml file defined in your home directory"
        )
        .addOption(
            new Option("-i, --interactive", "Enable interactive interface")
        )
        .action(async (options) => {
            await provideAuthentication(sso, (page) =>
                assignGraders(spinner, page, options.interactive)
            );
        });
}

function configureTestingCommand(command: Command, sso: SSO, spinner: Ora) {
    return command
        .command("doctor")
        .description(
            "Diagnose problems with the GHT tool and check if everything is working with Greenhouse."
        )
        .action(async () => {
            for (const test of tests) {
                await test(sso, spinner);
            }
        });
}

function configureCommand(command: Command, spinner: Ora) {
    command.description(
        "Greenhouse is a command-line tool that provides helpers to automate " +
            "interactions with the Canonical Greenhouse website."
    );

    const sso = new SSO(spinner);
    const replicateCommand = configureReplicateCommand(command, sso, spinner);
    const resetPostsCommand = configureResetCommand(command, sso, spinner);
    const loginCommand = configureLoginCommand(command, sso);
    const logoutCommand = configureLogoutCommand(command, sso);
    const testingCommand = configureTestingCommand(command, sso, spinner);
    const loadBalancerCommand = configureLoadBalancerCommand(
        command,
        sso,
        spinner
    );

    command.configureHelp({
        visibleCommands: () => {
            return [
                replicateCommand,
                resetPostsCommand,
                loginCommand,
                logoutCommand,
                testingCommand,
                loadBalancerCommand,
            ];
        },
    });
}

async function main() {
    setupSentry();
    const spinner = ora();
    try {
        const program = new Command();
        configureCommand(program, spinner);
        await program.parseAsync(process.argv);
    } catch (error) {
        displayError(<Error>error, spinner);
        process.exit(1);
    } finally {
        spinner.stop();
    }
}

main();
