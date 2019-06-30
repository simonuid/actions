import * as https from "request-promise-native"

import { GaxiosResponse } from "gaxios"
import { Credentials } from "google-auth-library"
import { chat_v1, google } from "googleapis"

import * as winston from "winston"
import * as Hub from "../../../hub"

export class GoogleHangoutsChatAction extends Hub.OAuthAction {
    name = "google_hangouts_chat"
    label = "Google Hangouts Chat"
    iconName = "google/chat/google_hangouts_chat.svg"
    description = "Send data to Google Hangouts Chat."
    supportedActionTypes = [Hub.ActionType.Dashboard, Hub.ActionType.Query]
    supportedFormats = [
      Hub.ActionFormat.WysiwygPdf,
      Hub.ActionFormat.AssembledPdf,
      Hub.ActionFormat.WysiwygPng,
    ]
    usesStreaming = false
    minimumSupportedLookerVersion = "6.8.0"
    requiredFields = []
    params = []

  async execute(request: Hub.ActionRequest) {
    const resp = new Hub.ActionResponse()

    if (!request.params.state_json) {
      resp.success = false
      resp.state = new Hub.ActionState()
      resp.state.data = "reset"
      return resp
    }

    if (!request.attachment || !request.attachment.dataBuffer) {
      throw "Couldn't get data from attachment."
    }

    if (!request.formParams.space) {
      throw "Missing space."
    }

    const plan = request.scheduledPlan
    if (!plan) {
      throw "Missing url."
    }
    const title = plan && plan.title ? plan.title : "Looker"
    const url = plan.url!

    const stateJson = JSON.parse(request.params.state_json)
    if (stateJson.tokens && stateJson.redirect) {
      const chat = await this.chatClientFromRequest(stateJson.redirect, stateJson.tokens)

      try {
        const params: chat_v1.Params$Resource$Spaces$Messages$Create = {
          requestBody: {
            space: {
              name: request.formParams.space,
            },
            text: "",
            cards: [{
              header: {
                title,
                imageUrl: "https://wwwstatic-d.lookercdn.com/logos/looker_black.svg",
              },
              sections: [{
                widgets: [{
                  textParagraph: { text: request.formParams.message || "" },
                  // todo figure out URL possible one time use?
                  // google may add an image attachment to the API
                  // https://issuetracker.google.com/issues/77501248
                  image: {
                    imageUrl: "",
                    onClick: {
                      openLink: {
                        url,
                      },
                    },
                  },
                  buttons: [{
                    textButton: {
                      text: "See data in Looker",
                      onClick: {
                        openLink: {
                          url,
                        },
                      },
                    },
                  }],
                }],
              }],
            }],
          },
        }
        await chat.spaces.messages.create(params)
        resp.success = true
      } catch (e) {
        resp.success = false
        resp.message = e.message
      }
    } else {
      resp.success = false
      resp.state = new Hub.ActionState()
      resp.state.data = "reset"
    }
    return resp
  }

  async form(request: Hub.ActionRequest) {
    const form = new Hub.ActionForm()
    form.fields = []

    const actionCrypto = new Hub.ActionCrypto()
    const jsonString = JSON.stringify({stateurl: request.params.state_url})
    const ciphertextBlob = await actionCrypto.encrypt(jsonString).catch((err: string) => {
      winston.error("Encryption not correctly configured")
      throw err
    })
    form.state = new Hub.ActionState()
    form.fields.push({
      name: "login",
      type: "oauth_link",
      label: "Log in",
      description: "In order to send to Google Hangouts Chat, you will need to log in" +
        " to your Google account.",
      oauth_url: `${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`,
    })

    if (request.params.state_json) {
      try {
        const stateJson = JSON.parse(request.params.state_json)
        if (stateJson.tokens && stateJson.redirect) {
          const chat = await this.chatClientFromRequest(stateJson.redirect, stateJson.tokens)

          const options: any = {
            pageSize: 1000,
          }

          async function pagedFileList(
            accumulatedFiles: chat_v1.Schema$Space[],
            response: GaxiosResponse<chat_v1.Schema$ListSpacesResponse>):
              Promise<chat_v1.Schema$Space[]> {
            const mergedFiles = accumulatedFiles.concat(response.data.spaces!)

            // When a `nextPageToken` exists, recursively call this function to get the next page.
            if (response.data.nextPageToken) {
              const pageOptions = { ...options }
              pageOptions.pageToken = response.data.nextPageToken
              return pagedFileList(mergedFiles, await chat.spaces.list(pageOptions))
            }
            return mergedFiles
          }
          const paginatedSpaces = await pagedFileList([], await chat.spaces.list(options))
          const spaces = paginatedSpaces.filter((space) => (
            !(space.name === undefined)))
            .map((space) => ({name: space.name!, label: space.displayName || space.name! }))
          form.fields = [{
            description: "Google Hangouts Chat space",
            label: "Select Space to send message",
            name: "space",
            options: spaces,
            required: true,
            type: "select",
          }, {
            label: "Enter a message to display",
            name: "message",
            type: "string",
            required: true,
          }]
          form.state = new Hub.ActionState()
          form.state.data = JSON.stringify({tokens: stateJson.tokens, redirect: stateJson.redirect})
          return form
        }
      } catch { winston.warn("Log in fail") }
    }
    return form
  }

  async oauthUrl(redirectUri: string, encryptedState: string) {
    const oauth2Client = this.oauth2Client(redirectUri)

    // generate a url that asks permissions for Google Drive scope
    const scopes = [
      "https://www.googleapis.com/auth/chat.bot",
    ]

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
      state: encryptedState,
    })
    return url.toString()
  }

  async oauthFetchInfo(urlParams: { [key: string]: string }, redirectUri: string) {
    const actionCrypto = new Hub.ActionCrypto()
    const plaintext = await actionCrypto.decrypt(urlParams.state).catch((err: string) => {
      winston.error("Encryption not correctly configured" + err)
      throw err
    })

    const tokens = await this.getAccessTokenCredentialsFromCode(redirectUri, urlParams.code)
    // Pass back context to Looker
    const payload = JSON.parse(plaintext)
    await https.post({
      url: payload.stateurl,
      body: JSON.stringify({tokens, redirect: redirectUri}),
    }).catch((_err) => { winston.error(_err.toString()) })
  }

  async oauthCheck(request: Hub.ActionRequest) {
    if (request.params.state_json) {
      const stateJson = JSON.parse(request.params.state_json)
      if (stateJson.tokens && stateJson.redirect) {
        const chat = await this.chatClientFromRequest(stateJson.redirect, stateJson.tokens)
        await chat.spaces.list({
          pageSize: 10,
        })
        return true
      }
    }
    return false
  }

  protected async getAccessTokenCredentialsFromCode(redirect: string, code: string) {
    const client = this.oauth2Client(redirect)
    const {tokens} = await client.getToken(code)
    return tokens
  }

  protected async chatClientFromRequest(redirect: string, tokens: Credentials) {
    const client = this.oauth2Client(redirect)
    client.setCredentials(tokens)
    return google.chat({version: "v1", auth: client})
  }

  private oauth2Client(redirectUri: string | undefined) {
    return new google.auth.OAuth2(
      process.env.GOOGLE_HANGOUTS_CHAT_CLIENT_ID,
      process.env.GOOGLE_HANGOUTS_CHAT_CLIENT_SECRET,
      redirectUri,
    )
  }
}

if (process.env.GOOGLE_HANGOUTS_CHAT_CLIENT_ID && process.env.GOOGLE_HANGOUTS_CHAT_CLIENT_SECRET) {
  Hub.addAction(new GoogleHangoutsChatAction())
}